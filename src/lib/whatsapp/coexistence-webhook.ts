import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

export interface SmbEchoMessage {
  from: string
  to: string
  id: string
  timestamp: string | number
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
}

export interface HistoryThreadMessage {
  id: string
  from: string
  timestamp: string | number
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
}

export interface HistoryThread {
  peer_recipient_id: string
  messages: HistoryThreadMessage[]
}

export function isCoexistenceWebhookField(field: string): boolean {
  return (
    field === 'smb_message_echoes' ||
    field === 'smb_app_state_sync' ||
    field === 'history' ||
    field === 'account_update'
  )
}

/**
 * Helper to resolve config by phone_number_id or WABA ID
 */
async function findConfig(
  supabase: SupabaseClient,
  identifiers: { phoneNumberId?: string; wabaId?: string }
) {
  let query = supabase.from('whatsapp_config').select('*')
  if (identifiers.phoneNumberId) {
    query = query.eq('phone_number_id', identifiers.phoneNumberId)
  } else if (identifiers.wabaId) {
    query = query.eq('waba_id', identifiers.wabaId)
  } else {
    return null
  }
  const { data } = await query.maybeSingle()
  return data
}

/**
 * Find or create contact by normalized phone number
 */
async function findOrCreateContactByPhone(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  phone: string,
  name?: string
) {
  const normalized = normalizePhone(phone)
  if (!normalized) return null

  // 1. Check existing
  const existing = await findExistingContact(supabase, accountId, normalized)
  if (existing) {
    if (!existing.name && name) {
      await supabase
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
      existing.name = name
    }
    return existing
  }

  // 2. Insert new contact
  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: userId,
      phone: normalized,
      name: name || undefined,
    })
    .select()
    .maybeSingle()

  if (error) {
    // If unique violation race, look up existing
    const raced = await findExistingContact(supabase, accountId, normalized)
    return raced || null
  }

  return created
}

interface AppStateContactOutcome {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contact: any
  change: 'created' | 'renamed' | null
  previousName: string | null
}

/**
 * Find, create, or rename contact during smb_app_state_sync.
 * Unlike findOrCreateContactByPhone, updates contacts.name when the sync
 * provides a non-empty name differing from the stored name.
 */
async function syncAppStateContact(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  phone: string,
  name?: string
): Promise<AppStateContactOutcome | null> {
  const normalized = normalizePhone(phone)
  if (!normalized) return null

  const trimmedName = name?.trim() || undefined

  // 1. Check existing
  const existing = await findExistingContact(supabase, accountId, normalized)
  if (existing) {
    if (trimmedName && trimmedName !== existing.name) {
      const previousName = existing.name ?? null
      await supabase
        .from('contacts')
        .update({ name: trimmedName, updated_at: new Date().toISOString() })
        .eq('id', existing.id)

      existing.name = trimmedName
      return {
        contact: existing,
        change: 'renamed',
        previousName,
      }
    }
    return {
      contact: existing,
      change: null,
      previousName: existing.name ?? null,
    }
  }

  // 2. Insert new contact
  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: userId,
      phone: normalized,
      name: trimmedName,
    })
    .select()
    .maybeSingle()

  if (error) {
    // If unique violation race, look up existing
    const raced = await findExistingContact(supabase, accountId, normalized)
    if (raced) {
      if (trimmedName && trimmedName !== raced.name) {
        const previousName = raced.name ?? null
        await supabase
          .from('contacts')
          .update({ name: trimmedName, updated_at: new Date().toISOString() })
          .eq('id', raced.id)

        raced.name = trimmedName
        return {
          contact: raced,
          change: 'renamed',
          previousName,
        }
      }
      return {
        contact: raced,
        change: null,
        previousName: raced.name ?? null,
      }
    }
    return null
  }

  return {
    contact: created,
    change: 'created',
    previousName: null,
  }
}

/**
 * Find or create conversation for contact
 */
async function findOrCreateConversationForContact(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string
) {
  const { data: existingRows } = await supabase
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (existingRows && existingRows.length > 0) {
    return existingRows[0]
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select()
    .maybeSingle()

  if (error) {
    const { data: raced } = await supabase
      .from('conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .limit(1)
    return raced?.[0] || null
  }

  return created
}

/**
 * 1. Handle `smb_message_echoes`
 * Messages sent by the business from the WhatsApp Business mobile app.
 * Marked as source = 'business_app' and sender_type = 'agent'.
 */
export async function handleSmbMessageEchoes(
  supabase: SupabaseClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  wabaId?: string
) {
  const phoneNumberId = value.metadata?.phone_number_id
  const config = await findConfig(supabase, { phoneNumberId, wabaId })
  if (!config) {
    console.warn('[coexistence-webhook] smb_message_echoes: Config not found for phone_number_id:', phoneNumberId)
    return
  }

  const echoes: SmbEchoMessage[] = value.message_echoes || []
  for (const echo of echoes) {
    const customerPhone = normalizePhone(echo.to)
    if (!customerPhone) continue

    const contact = await findOrCreateContactByPhone(
      supabase,
      config.account_id,
      config.user_id,
      customerPhone
    )
    if (!contact) continue

    const conversation = await findOrCreateConversationForContact(
      supabase,
      config.account_id,
      config.user_id,
      contact.id
    )
    if (!conversation) continue

    const ALLOWED_CONTENT_TYPES = new Set(['text', 'image', 'document', 'audio', 'video', 'location'])
    const contentType = ALLOWED_CONTENT_TYPES.has(echo.type) ? echo.type : 'text'
    const contentText =
      echo.text?.body ||
      echo.image?.caption ||
      echo.video?.caption ||
      echo.document?.caption ||
      (echo.type !== 'text' ? `[${echo.type}]` : '')

    const timestampSec = typeof echo.timestamp === 'string' ? parseInt(echo.timestamp, 10) : echo.timestamp
    const createdAt = !isNaN(timestampSec) ? new Date(timestampSec * 1000).toISOString() : new Date().toISOString()

    // Idempotent message insert
    const { data: inserted, error: insertError } = await supabase
      .from('messages')
      .upsert(
        {
          conversation_id: conversation.id,
          sender_type: 'agent',
          source: 'business_app',
          content_type: contentType,
          content_text: contentText,
          message_id: echo.id,
          status: 'delivered',
          created_at: createdAt,
        },
        { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
      )
      .select('id')

    if (insertError) {
      console.error('[coexistence-webhook] Echo insert failed:', insertError)
      continue
    }

    // If duplicate was ignored, skip updating conversation
    if (!inserted || inserted.length === 0) continue

    // Update conversation summary
    await supabase
      .from('conversations')
      .update({
        last_message_text: contentText,
        last_message_at: createdAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)

    // Announce message.echo to webhooks
    await dispatchWebhookEvent(supabase, config.account_id, 'message.echo', {
      conversation_id: conversation.id,
      contact_id: contact.id,
      contact_phone: customerPhone,
      whatsapp_message_id: echo.id,
      content_type: contentType,
      text: contentText,
      source: 'business_app',
      sent_at: createdAt,
    })
  }
}

/**
 * 2. Handle `smb_app_state_sync`
 * Synchronizes contacts from the phone address book into wacrm Contacts without duplicates.
 */
export async function handleSmbAppStateSync(
  supabase: SupabaseClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  wabaId?: string
) {
  const phoneNumberId = value.metadata?.phone_number_id
  const config = await findConfig(supabase, { phoneNumberId, wabaId })
  if (!config) {
    console.warn('[coexistence-webhook] smb_app_state_sync: Config not found for phone_number_id:', phoneNumberId)
    return
  }

  const action = value.action || 'add'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contactsList: any[] = value.contacts || []

  if (action === 'add' || action === 'update') {
    for (const c of contactsList) {
      const phone = c.wa_id || c.input
      if (!phone) continue

      const name = c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || undefined
      const outcome = await syncAppStateContact(
        supabase,
        config.account_id,
        config.user_id,
        phone,
        name
      )
      if (!outcome || !outcome.change) continue

      await dispatchWebhookEvent(supabase, config.account_id, 'contact.updated', {
        contact_id: outcome.contact.id,
        phone: normalizePhone(outcome.contact.phone || phone),
        name: outcome.contact.name ?? (name?.trim() || null),
        previous_name: outcome.previousName,
        change: outcome.change,
      })
    }
  }

  // Update sync status on whatsapp_config
  await supabase
    .from('whatsapp_config')
    .update({
      contacts_sync_status: 'completed',
      contacts_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', config.id)
}

/**
 * 3. Handle `history`
 * Ingests historical chat threads in chunks/phases idempotently.
 */
export async function handleHistorySync(
  supabase: SupabaseClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  wabaId?: string
) {
  const phoneNumberId = value.metadata?.phone_number_id
  const config = await findConfig(supabase, { phoneNumberId, wabaId })
  if (!config) {
    console.warn('[coexistence-webhook] history: Config not found for phone_number_id:', phoneNumberId)
    return
  }

  // Handle user decline error (e.g. 2593109)
  if (value.errors && value.errors.length > 0) {
    console.info('[coexistence-webhook] History sync declined or returned error:', value.errors)
    await supabase
      .from('whatsapp_config')
      .update({
        history_sync_status: 'declined',
        updated_at: new Date().toISOString(),
      })
      .eq('id', config.id)
    return
  }

  const syncData = value.sync_data
  if (!syncData) return

  const progress = typeof syncData.progress === 'number' ? syncData.progress : 0
  const isDone = progress >= 100
  const threads: HistoryThread[] = syncData.threads || []
  const businessPhone = normalizePhone(value.metadata?.display_phone_number || '')

  for (const thread of threads) {
    const customerPhone = normalizePhone(thread.peer_recipient_id)
    if (!customerPhone) continue

    const contact = await findOrCreateContactByPhone(
      supabase,
      config.account_id,
      config.user_id,
      customerPhone
    )
    if (!contact) continue

    const conversation = await findOrCreateConversationForContact(
      supabase,
      config.account_id,
      config.user_id,
      contact.id
    )
    if (!conversation) continue

    for (const msg of thread.messages || []) {
      const isOutbound = businessPhone && normalizePhone(msg.from) === businessPhone
      const senderType = isOutbound ? 'agent' : 'customer'
      const source = isOutbound ? 'business_app' : 'wacrm'

      const ALLOWED_CONTENT_TYPES = new Set(['text', 'image', 'document', 'audio', 'video', 'location'])
      const contentType = ALLOWED_CONTENT_TYPES.has(msg.type) ? msg.type : 'text'
      const contentText =
        msg.text?.body ||
        msg.image?.caption ||
        msg.video?.caption ||
        msg.document?.caption ||
        (msg.type !== 'text' ? `[${msg.type}]` : '')

      const timestampSec = typeof msg.timestamp === 'string' ? parseInt(msg.timestamp, 10) : msg.timestamp
      const createdAt = !isNaN(timestampSec) ? new Date(timestampSec * 1000).toISOString() : new Date().toISOString()

      // Idempotent insertion
      await supabase
        .from('messages')
        .upsert(
          {
            conversation_id: conversation.id,
            sender_type: senderType,
            source,
            content_type: contentType,
            content_text: contentText,
            message_id: msg.id,
            status: 'read',
            created_at: createdAt,
          },
          { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
        )
    }
  }

  // Update sync progress
  await supabase
    .from('whatsapp_config')
    .update({
      history_sync_progress: progress,
      history_sync_status: isDone ? 'completed' : 'in_progress',
      history_synced_at: isDone ? new Date().toISOString() : config.history_synced_at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', config.id)
}

/**
 * 4. Handle `account_update`
 * Detects offboarding or disconnects from the phone app side.
 * Never attempts to re-register.
 */
export async function handleAccountUpdate(
  supabase: SupabaseClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  wabaId?: string
) {
  const phoneNumberId = value.metadata?.phone_number_id || value.phone_number_id
  const config = await findConfig(supabase, { phoneNumberId, wabaId })
  if (!config) return

  const event = value.event || value.action
  const isOffboarded =
    event === 'ACCOUNT_OFFBOARDED' ||
    event === 'DISABLED' ||
    event === 'PARTNER_REMOVED' ||
    value.ban_info != null

  if (isOffboarded && config.connection_mode === 'coexistence') {
    console.warn(`[coexistence-webhook] Account offboarded / disconnected event received: ${event}`)
    await supabase
      .from('whatsapp_config')
      .update({
        status: 'disconnected',
        coexistence_disconnected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', config.id)
  }
}
