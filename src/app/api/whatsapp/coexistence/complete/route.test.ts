import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'

const mockExchangeCode = vi.fn()
const mockVerifyPhone = vi.fn()
const mockSubscribeWaba = vi.fn()
const mockSyncSmbAppData = vi.fn()
const mockEncrypt = vi.fn()

vi.mock('@/lib/whatsapp/meta-api', () => ({
  exchangeCodeForToken: (...args: unknown[]) => mockExchangeCode(...args),
  verifyPhoneNumber: (...args: unknown[]) => mockVerifyPhone(...args),
  subscribeWabaToApp: (...args: unknown[]) => mockSubscribeWaba(...args),
  requestSmbAppDataSync: (...args: unknown[]) => mockSyncSmbAppData(...args),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
}))

const mockGetUser = vi.fn()
const mockSupabase = {
  auth: {
    getUser: () => mockGetUser(),
  },
  from: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const mockAdminSupabase = {
  from: vi.fn(),
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockAdminSupabase,
}))

describe('POST /api/whatsapp/coexistence/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.META_APP_ID = '2500828570328558'
    process.env.META_APP_SECRET = 'test-secret'

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockExchangeCode.mockResolvedValue({
      access_token: 'permanent-access-token',
    })

    mockVerifyPhone.mockResolvedValue({
      display_phone_number: '+1 555-0199',
      verified_name: 'Affan Business',
      quality_rating: 'GREEN',
    })

    mockSubscribeWaba.mockResolvedValue({ success: true })
    mockSyncSmbAppData.mockResolvedValue({ success: true, request_id: 'req-1' })
    mockEncrypt.mockReturnValue('encrypted-token')
  })

  it('rejects invalid or non-numeric Meta IDs', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { account_id: 'acc-1' },
            error: null,
          }),
        }
      }
      return {}
    })

    const req = new Request('http://localhost/api/whatsapp/coexistence/complete', {
      method: 'POST',
      body: JSON.stringify({
        code: 'auth-code',
        phone_number_id: 'not-numeric',
        waba_id: '1234567890',
      }),
    })

    const res = await POST(req)
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain('numeric')
  })

  it('exchanges code, subscribes WABA, requests sync, and saves coexistence config without calling /register', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { account_id: 'acc-1' },
            error: null,
          }),
        }
      }
      if (table === 'whatsapp_config') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          insert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
          upsert: vi.fn().mockResolvedValue({ error: null }),
        }
      }
      return {}
    })

    mockAdminSupabase.from.mockImplementation((table: string) => {
      if (table === 'whatsapp_config') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          neq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }
      }
      return {}
    })

    const req = new Request('http://localhost/api/whatsapp/coexistence/complete', {
      method: 'POST',
      body: JSON.stringify({
        code: 'sample-oauth-code',
        phone_number_id: '100234567890123',
        waba_id: '200234567890456',
      }),
    })

    const res = await POST(req)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.phone_info).toEqual({
      display_phone_number: '+1 555-0199',
      verified_name: 'Affan Business',
      quality_rating: 'GREEN',
    })

    // Verified correct sequence:
    expect(mockExchangeCode).toHaveBeenCalledWith({
      code: 'sample-oauth-code',
      clientId: '2500828570328558',
      clientSecret: 'test-secret',
    })
    expect(mockVerifyPhone).toHaveBeenCalledWith({
      phoneNumberId: '100234567890123',
      accessToken: 'permanent-access-token',
    })
    expect(mockSubscribeWaba).toHaveBeenCalledWith({
      wabaId: '200234567890456',
      accessToken: 'permanent-access-token',
    })
    // Both contacts and chats sync requested
    expect(mockSyncSmbAppData).toHaveBeenCalledTimes(2)
  })
})
