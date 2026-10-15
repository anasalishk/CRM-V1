import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assertNotCoexistence, CoexistenceGuardError } from './coexistence-guard'

// Mock Supabase admin client
const mockMaybeSingle = vi.fn()
const mockEq = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle })
const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
const mockFrom = vi.fn().mockReturnValue({ select: mockSelect })

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: mockFrom,
  }),
}))

describe('coexistence-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://mock.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-key'
  })

  it('throws CoexistenceGuardError when connectionMode is coexistence directly', async () => {
    await expect(
      assertNotCoexistence({ connectionMode: 'coexistence' })
    ).rejects.toThrow(CoexistenceGuardError)
  })

  it('allows execution when connectionMode is cloud_api directly', async () => {
    await expect(
      assertNotCoexistence({ connectionMode: 'cloud_api' })
    ).resolves.toBeUndefined()
  })

  it('throws CoexistenceGuardError when database returns coexistence mode for phoneNumberId', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { connection_mode: 'coexistence' },
      error: null,
    })

    await expect(
      assertNotCoexistence({ phoneNumberId: '123456789' })
    ).rejects.toThrow(CoexistenceGuardError)

    expect(mockFrom).toHaveBeenCalledWith('whatsapp_config')
    expect(mockSelect).toHaveBeenCalledWith('connection_mode')
    expect(mockEq).toHaveBeenCalledWith('phone_number_id', '123456789')
  })

  it('throws CoexistenceGuardError when database returns coexistence mode for accountId', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { connection_mode: 'coexistence' },
      error: null,
    })

    await expect(
      assertNotCoexistence({ accountId: 'acc-uuid-1' })
    ).rejects.toThrow(CoexistenceGuardError)

    expect(mockFrom).toHaveBeenCalledWith('whatsapp_config')
    expect(mockSelect).toHaveBeenCalledWith('connection_mode')
    expect(mockEq).toHaveBeenCalledWith('account_id', 'acc-uuid-1')
  })

  it('allows execution when database returns cloud_api mode', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { connection_mode: 'cloud_api' },
      error: null,
    })

    await expect(
      assertNotCoexistence({ phoneNumberId: '987654321' })
    ).resolves.toBeUndefined()
  })

  it('allows execution when no record is found in database', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    })

    await expect(
      assertNotCoexistence({ phoneNumberId: 'non-existent-id' })
    ).resolves.toBeUndefined()
  })
})
