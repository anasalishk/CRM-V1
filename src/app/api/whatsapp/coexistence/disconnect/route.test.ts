import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'

const mockUnsubscribe = vi.fn()
const mockDecrypt = vi.fn()

vi.mock('@/lib/whatsapp/meta-api', () => ({
  unsubscribeWabaFromApp: (...args: unknown[]) => mockUnsubscribe(...args),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
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

describe('POST /api/whatsapp/coexistence/disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockDecrypt.mockReturnValue('decrypted-token')
    mockUnsubscribe.mockResolvedValue({ success: true })
  })

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Unauthorized' },
    })

    const res = await POST()
    const data = await res.json()

    expect(res.status).toBe(401)
    expect(data.error).toBeDefined()
  })

  it('unsubscribes WABA from Meta App and marks status as disconnected', async () => {
    const updateSpy = vi.fn().mockReturnThis()
    const eqSpy = vi.fn().mockResolvedValue({ error: null })

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
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: 'cfg-1',
              waba_id: '1234567890',
              access_token: 'enc-token',
              connection_mode: 'coexistence',
            },
            error: null,
          }),
          update: updateSpy.mockReturnValue({ eq: eqSpy }),
        }
      }
      return {}
    })

    const res = await POST()
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(mockUnsubscribe).toHaveBeenCalledWith({
      wabaId: '1234567890',
      accessToken: 'decrypted-token',
    })
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'disconnected',
      })
    )
  })
})
