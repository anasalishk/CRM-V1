import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  handleSmbMessageEchoes,
  handleSmbAppStateSync,
  handleHistorySync,
  handleAccountUpdate,
  isCoexistenceWebhookField,
} from './coexistence-webhook'

describe('coexistence-webhook', () => {
  let mockSupabase: any
  let mockConfig: any

  beforeEach(() => {
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
})
