import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { unsubscribeWabaFromApp } from '@/lib/whatsapp/meta-api'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

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
 * POST /api/whatsapp/coexistence/disconnect
 *
 * Safely disconnects a Coexistence number:
 * - Unsubscribes our Meta App from the WABA (DELETE /{waba_id}/subscribed_apps).
 * - Marks the local status as 'disconnected'.
 * - NEVER calls /deregister or affects the mobile WhatsApp Business App!
 */
export async function POST() {
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

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('id, waba_id, access_token, connection_mode')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError || !config) {
      return NextResponse.json({ error: t('whatsappConfig.noConfigShort') }, { status: 404 })
    }

    // Unsubscribe WABA from Meta App if credentials are valid
    if (config.waba_id && config.access_token) {
      try {
        const decryptedToken = decrypt(config.access_token)
        await unsubscribeWabaFromApp({
          wabaId: config.waba_id,
          accessToken: decryptedToken,
        })
      } catch (err) {
        console.warn('[coexistence/disconnect] WABA unsubscribe error (continuing local disconnect):', err)
      }
    }

    const now = new Date().toISOString()
    const { error: updateError } = await supabase
      .from('whatsapp_config')
      .update({
        status: 'disconnected',
        coexistence_disconnected_at: now,
        updated_at: now,
      })
      .eq('account_id', accountId)

    if (updateError) {
      console.error('[coexistence/disconnect] Update error:', updateError)
      return NextResponse.json({ error: t('whatsappConfig.updateFailed') }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in coexistence/disconnect POST:', error)
    return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 })
  }
}
