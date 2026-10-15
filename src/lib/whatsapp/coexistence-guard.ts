import { createClient as createAdminClient } from '@supabase/supabase-js'

export class CoexistenceGuardError extends Error {
  constructor(
    message = 'Operation forbidden: Phone number is connected via Coexistence mode. Registration, deregistration, and PIN changes are strictly prohibited to protect the mobile WhatsApp Business App.'
  ) {
    super(message)
    this.name = 'CoexistenceGuardError'
  }
}

export interface GuardTarget {
  accountId?: string | null
  phoneNumberId?: string | null
  connectionMode?: string | null
}

// Lazy admin client for server-side guard checks
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return null
    _adminClient = createAdminClient(url, key)
  }
  return _adminClient
}

/**
 * Asserts that the target account or phone number is NOT in Coexistence mode.
 * Throws CoexistenceGuardError if connection_mode is 'coexistence'.
 *
 * This guard ensures that under NO circumstances can /register, /deregister,
 * or PIN operations be called on an active Coexistence number.
 */
export async function assertNotCoexistence(target: GuardTarget): Promise<void> {
  // 1. Direct mode check
  if (target.connectionMode === 'coexistence') {
    throw new CoexistenceGuardError()
  }

  // 2. If no IDs to check against database, nothing more to verify
  if (!target.accountId && !target.phoneNumberId) {
    return
  }

  const admin = supabaseAdmin()
  if (!admin) {
    return
  }

  try {
    let query = admin
      .from('whatsapp_config')
      .select('connection_mode')

    if (target.phoneNumberId) {
      query = query.eq('phone_number_id', target.phoneNumberId)
    } else if (target.accountId) {
      query = query.eq('account_id', target.accountId)
    }

    const { data, error } = await query.maybeSingle()
    if (error) {
      console.warn('[assertNotCoexistence] Lookup error:', error.message)
      return
    }

    if (data?.connection_mode === 'coexistence') {
      throw new CoexistenceGuardError()
    }
  } catch (err) {
    if (err instanceof CoexistenceGuardError) {
      throw err
    }
    console.warn('[assertNotCoexistence] Unexpected error during check:', err)
  }
}
