import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  exchangeCodeForToken,
  requestSmbAppDataSync,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt } from '@/lib/whatsapp/encryption'
import { isNumericMetaId } from '@/lib/whatsapp/waba-pairing'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// Lazy-initialised service-role client to detect phone_number_id cross-account conflicts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * POST /api/whatsapp/coexistence/complete
 *
 * Finalizes the Meta Embedded Signup Coexistence onboarding flow:
 * 1. Exchanges auth code for permanent business access token.
 * 2. Fetches phone number details from Graph API.
 * 3. Subscribes our Meta App to the WABA.
 * 4. NEVER calls POST /{phone_number_id}/register or changes PIN!
 * 5. Initiates contacts sync and chat history sync via POST /{phone_number_id}/smb_app_data.
 * 6. Stores credentials encrypted with connection_mode = 'coexistence'.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: t('common.unauthorized') }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: t('common.profileNotLinked') }, { status: 403 })
    }

    const body = await request.json()
    const { code, phone_number_id, waba_id } = body

    if (!code || !phone_number_id || !waba_id) {
      return NextResponse.json(
        { error: 'Missing required onboarding parameters (code, phone_number_id, waba_id).' },
        { status: 400 }
      )
    }

    if (!isNumericMetaId(phone_number_id) || !isNumericMetaId(waba_id)) {
      return NextResponse.json(
        { error: 'Invalid Meta ID format. phone_number_id and waba_id must be numeric.' },
        { status: 400 }
      )
    }

    const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID
    const appSecret = (process.env.META_APP_SECRET || '').split(',')[0].trim()

    if (!appId || !appSecret) {
      return NextResponse.json(
        { error: 'Server configuration error: META_APP_ID or META_APP_SECRET is not configured.' },
        { status: 500 }
      )
    }

    // Reject if another account has already claimed this phone_number_id
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('[coexistence/complete] Error checking phone ownership:', claimedError)
      return NextResponse.json({ error: t('whatsappConfig.validateFailed') }, { status: 500 })
    }

    if (claimed) {
      return NextResponse.json(
        { error: t('whatsappConfig.numberLinkedElsewhere') },
        { status: 409 }
      )
    }

    // Step a: Exchange auth code for business access token
    let accessToken: string
    try {
      const tokenResult = await exchangeCodeForToken({
        clientId: appId,
        clientSecret: appSecret,
        code,
      })
      accessToken = tokenResult.access_token
    } catch (err) {
      console.error('[coexistence/complete] Token exchange failed:', err)
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to exchange authorization code for access token.' },
        { status: 400 }
      )
    }

    // Step b: Fetch phone number details
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken,
      })
    } catch (err) {
      console.error('[coexistence/complete] Phone verification failed:', err)
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to verify phone number metadata with Meta.' },
        { status: 400 }
      )
    }

    // Step c: Subscribe app to WABA
    try {
      await subscribeWabaToApp({
        wabaId: waba_id,
        accessToken,
      })
    } catch (err) {
      console.error('[coexistence/complete] WABA subscription failed:', err)
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to subscribe Meta App to WhatsApp Business Account.' },
        { status: 502 }
      )
    }

    // Step d: NEVER call POST /{phone_number_id}/register or change PIN!
    // (Coexistence numbers are automatically registered through the mobile app).

    // Step e: Initiate data sync (must happen within 24h window)
    let contactsSyncRequestId: string | null = null
    let contactsSyncStatus: 'in_progress' | 'failed' = 'in_progress'
    try {
      const contactsRes = await requestSmbAppDataSync({
        phoneNumberId: phone_number_id,
        accessToken,
        syncType: 'smb_app_state_sync',
      })
      contactsSyncRequestId = contactsRes.request_id ?? null
    } catch (err) {
      console.warn('[coexistence/complete] Contacts sync initiation failed:', err)
      contactsSyncStatus = 'failed'
    }

    let historySyncRequestId: string | null = null
    let historySyncStatus: 'in_progress' | 'failed' = 'in_progress'
    try {
      const historyRes = await requestSmbAppDataSync({
        phoneNumberId: phone_number_id,
        accessToken,
        syncType: 'history',
      })
      historySyncRequestId = historyRes.request_id ?? null
    } catch (err) {
      console.warn('[coexistence/complete] History sync initiation failed (user may have opted out):', err)
      historySyncStatus = 'failed'
    }

    // Step f: Save the connection in the DB
    let encryptedAccessToken: string
    try {
      encryptedAccessToken = encrypt(accessToken)
    } catch (err) {
      console.error('[coexistence/complete] Encryption failed:', err)
      return NextResponse.json({ error: t('whatsappConfig.encryptFailed') }, { status: 500 })
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, verify_token')
      .eq('account_id', accountId)
      .maybeSingle()

    const now = new Date().toISOString()
    const configRow = {
      phone_number_id,
      waba_id,
      access_token: encryptedAccessToken,
      verify_token: existing?.verify_token ?? null,
      status: 'connected',
      connection_mode: 'coexistence',
      connected_at: now,
      coexistence_onboarded_at: now,
      subscribed_apps_at: now,
      registered_at: null, // Hard rule: Keep registered_at null for coexistence
      last_registration_error: null,
      contacts_sync_status: contactsSyncStatus,
      history_sync_status: historySyncStatus,
      history_sync_progress: 0,
      contacts_sync_request_id: contactsSyncRequestId,
      history_sync_request_id: historySyncRequestId,
      updated_at: now,
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(configRow)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('[coexistence/complete] Update error:', updateError)
        return NextResponse.json({ error: t('whatsappConfig.updateFailed') }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          ...configRow,
        })

      if (insertError) {
        console.error('[coexistence/complete] Insert error:', insertError)
        return NextResponse.json({ error: t('whatsappConfig.saveFailed') }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      connection_mode: 'coexistence',
      phone_info: phoneInfo,
      contacts_sync_status: contactsSyncStatus,
      history_sync_status: historySyncStatus,
    })
  } catch (error) {
    console.error('Error in coexistence/complete POST:', error)
    return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 })
  }
}
