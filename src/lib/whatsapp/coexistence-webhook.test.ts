import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  handleSmbMessageEchoes,
  handleSmbAppStateSync,
  handleHistorySync,
  handleAccountUpdate,
  isCoexistenceWebhookField,
} from './coexistence-webhook'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}))

describe('coexistence-webhook', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSupabase: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockConfig: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockConfig = {
      id: 'cfg-1',
      account_id: 'acc-1',
      user_id: 'user-admin',
      phone_number_id: 'phone-1',
      waba_id: 'waba-1',
      connection_mode: 'coexistence',
      status: 'connected',
    }

    mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_config') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: mockConfig }),
            update: vi.fn().mockReturnThis(),
          }
        }
        if (table === 'contacts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            like: vi.fn().mockResolvedValue({
              data: [{ id: 'contact-1', phone: '+16505551234', name: 'Test Customer' }],
              error: null,
            }),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: 'contact-1', phone: '+16505551234', name: 'Test Customer' },
            }),
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: 'contact-new', phone: '+16505559999' },
                }),
              }),
            }),
            update: vi.fn().mockReturnThis(),
          }
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'conv-1' } }),
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'conv-new' } }),
              }),
            }),
            update: vi.fn().mockReturnThis(),
          }
        }
        if (table === 'messages') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({ data: [{ id: 'msg-1' }], error: null }),
            }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({ data: [{ id: 'msg-1' }], error: null }),
            }),
          }
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
        }
      }),
    }
  })

  it('identifies coexistence webhook fields correctly', () => {
    expect(isCoexistenceWebhookField('smb_message_echoes')).toBe(true)
    expect(isCoexistenceWebhookField('smb_app_state_sync')).toBe(true)
    expect(isCoexistenceWebhookField('history')).toBe(true)
    expect(isCoexistenceWebhookField('account_update')).toBe(true)
    expect(isCoexistenceWebhookField('messages')).toBe(false)
  })

  it('handles smb_message_echoes by saving message with source=business_app', async () => {
    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1' },
      message_echoes: [
        {
          from: '15550783881',
          to: '16505551234',
          id: 'wamid.echo123',
          timestamp: '1739321024',
          type: 'text',
          text: { body: 'Hello from Business App on phone!' },
        },
      ],
    }

    await handleSmbMessageEchoes(mockSupabase, value, 'waba-1')

    expect(mockSupabase.from).toHaveBeenCalledWith('messages')
  })

  it('handles smb_app_state_sync by syncing contacts and updating status', async () => {
    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1' },
      action: 'add',
      contacts: [
        {
          wa_id: '16505550123',
          name: 'Jane Doe',
          first_name: 'Jane',
          last_name: 'Doe',
        },
      ],
    }

    await handleSmbAppStateSync(mockSupabase, value, 'waba-1')

    expect(mockSupabase.from).toHaveBeenCalledWith('whatsapp_config')
  })

  it('handles history sync by ingesting threads and updating progress', async () => {
    const value = {
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '15550783881',
        phone_number_id: 'phone-1',
      },
      sync_data: {
        phase: 0,
        chunk_order: 1,
        progress: 100,
        threads: [
          {
            peer_recipient_id: '16505551234',
            messages: [
              {
                id: 'wamid.hist1',
                from: '16505551234',
                timestamp: '1717152000',
                type: 'text',
                text: { body: 'Inbound history message' },
              },
            ],
          },
        ],
      },
    }

    await handleHistorySync(mockSupabase, value, 'waba-1')

    expect(mockSupabase.from).toHaveBeenCalledWith('messages')
    expect(mockSupabase.from).toHaveBeenCalledWith('whatsapp_config')
  })

  it('handles history sync decline error gracefully', async () => {
    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1' },
      errors: [
        {
          code: 2593109,
          title: 'User declined chat history sharing',
        },
      ],
    }

    await handleHistorySync(mockSupabase, value, 'waba-1')

    expect(mockSupabase.from).toHaveBeenCalledWith('whatsapp_config')
  })

  it('handles account_update by setting disconnected status on offboarded event', async () => {
    const value = {
      phone_number_id: 'phone-1',
      event: 'ACCOUNT_OFFBOARDED',
    }

    await handleAccountUpdate(mockSupabase, value, 'waba-1')

    expect(mockSupabase.from).toHaveBeenCalledWith('whatsapp_config')
  })

  it('dispatches message.echo when an echo is inserted successfully', async () => {
    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1' },
      message_echoes: [
        {
          from: '15550783881',
          to: '16505551234',
          id: 'wamid.echo123',
          timestamp: '1739321024',
          type: 'text',
          text: { body: 'Hello from Business App on phone!' },
        },
      ],
    }

    await handleSmbMessageEchoes(mockSupabase, value, 'waba-1')

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      mockSupabase,
      'acc-1',
      'message.echo',
      {
        conversation_id: 'conv-new',
        contact_id: 'contact-1',
        contact_phone: '16505551234',
        whatsapp_message_id: 'wamid.echo123',
        content_type: 'text',
        text: 'Hello from Business App on phone!',
        source: 'business_app',
        sent_at: new Date(1739321024 * 1000).toISOString(),
      }
    )
  })

  it('does NOT dispatch message.echo when the upsert was ignored as a duplicate', async () => {
    const origFrom = mockSupabase.from
    mockSupabase.from = vi.fn((table: string) => {
      if (table === 'messages') {
        return {
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }
      }
      return origFrom(table)
    })

    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1' },
      message_echoes: [
        {
          from: '15550783881',
          to: '16505551234',
          id: 'wamid.echo123',
          timestamp: '1739321024',
          type: 'text',
          text: { body: 'Hello from Business App on phone!' },
        },
      ],
    }

    await handleSmbMessageEchoes(mockSupabase, value, 'waba-1')

    expect(dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('dispatches contact.updated with change=created when contact is created by sync', async () => {
    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1' },
      action: 'add',
      contacts: [
        {
          wa_id: '16505559999',
          name: 'Jane Doe',
        },
      ],
    }

    await handleSmbAppStateSync(mockSupabase, value, 'waba-1')

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      mockSupabase,
      'acc-1',
      'contact.updated',
      {
        contact_id: 'contact-new',
        phone: '16505559999',
        name: 'Jane Doe',
        previous_name: null,
        change: 'created',
      }
    )
  })

  it('renames contact and dispatches contact.updated with change=renamed when sync provides differing name', async () => {
    const updateSpy = vi.fn().mockReturnThis()
    const eqSpy = vi.fn().mockResolvedValue({ error: null })
    updateSpy.mockReturnValue({ eq: eqSpy })

    mockSupabase.from = vi.fn((table: string) => {
      if (table === 'whatsapp_config') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: mockConfig }),
          update: vi.fn().mockReturnThis(),
        }
      }
      if (table === 'contacts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          like: vi.fn().mockResolvedValue({
            data: [{ id: 'contact-1', phone: '+16505551234', name: 'Original Name' }],
            error: null,
          }),
          update: updateSpy,
        }
      }
      return { select: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() }
    })

    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1' },
      action: 'update',
      contacts: [
        {
          wa_id: '16505551234',
          name: 'Renamed Customer',
        },
      ],
    }

    await handleSmbAppStateSync(mockSupabase, value, 'waba-1')

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Renamed Customer' })
    )
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      mockSupabase,
      'acc-1',
      'contact.updated',
      {
        contact_id: 'contact-1',
        phone: '16505551234',
        name: 'Renamed Customer',
        previous_name: 'Original Name',
        change: 'renamed',
      }
    )
  })

  it('does NOT update contact and does NOT dispatch when name is unchanged', async () => {
    const updateSpy = vi.fn().mockReturnThis()

    mockSupabase.from = vi.fn((table: string) => {
      if (table === 'whatsapp_config') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: mockConfig }),
          update: vi.fn().mockReturnThis(),
        }
      }
      if (table === 'contacts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          like: vi.fn().mockResolvedValue({
            data: [{ id: 'contact-1', phone: '+16505551234', name: 'Test Customer' }],
            error: null,
          }),
          update: updateSpy,
        }
      }
      return { select: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() }
    })

    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1' },
      action: 'update',
      contacts: [
        {
          wa_id: '16505551234',
          name: 'Test Customer',
        },
      ],
    }

    await handleSmbAppStateSync(mockSupabase, value, 'waba-1')

    expect(updateSpy).not.toHaveBeenCalled()
    expect(dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('does NOT update contact and does NOT dispatch when sync provides empty name', async () => {
    const updateSpy = vi.fn().mockReturnThis()

    mockSupabase.from = vi.fn((table: string) => {
      if (table === 'whatsapp_config') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: mockConfig }),
          update: vi.fn().mockReturnThis(),
        }
      }
      if (table === 'contacts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          like: vi.fn().mockResolvedValue({
            data: [{ id: 'contact-1', phone: '+16505551234', name: 'Test Customer' }],
            error: null,
          }),
          update: updateSpy,
        }
      }
      return { select: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() }
    })

    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1' },
      action: 'update',
      contacts: [
        {
          wa_id: '16505551234',
          name: '   ',
        },
      ],
    }

    await handleSmbAppStateSync(mockSupabase, value, 'waba-1')

    expect(updateSpy).not.toHaveBeenCalled()
    expect(dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('does NOT rename an existing contact during history sync', async () => {
    const updateSpy = vi.fn().mockReturnThis()

    const origFrom = mockSupabase.from
    mockSupabase.from = vi.fn((table: string) => {
      if (table === 'contacts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          like: vi.fn().mockResolvedValue({
            data: [{ id: 'contact-1', phone: '+16505551234', name: 'Original Name' }],
            error: null,
          }),
          update: updateSpy,
        }
      }
      return origFrom(table)
    })

    const value = {
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '15550783881',
        phone_number_id: 'phone-1',
      },
      sync_data: {
        phase: 0,
        chunk_order: 1,
        progress: 100,
        threads: [
          {
            peer_recipient_id: '16505551234',
            messages: [
              {
                id: 'wamid.hist1',
                from: '16505551234',
                timestamp: '1717152000',
                type: 'text',
                text: { body: 'Inbound message' },
              },
            ],
          },
        ],
      },
    }

    await handleHistorySync(mockSupabase, value, 'waba-1')

    expect(updateSpy).not.toHaveBeenCalled()
  })
})
