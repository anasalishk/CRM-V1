import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GET } from './route'

describe('GET /api/whatsapp/coexistence/client-config', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns configured: false when env vars are missing', async () => {
    delete process.env.META_APP_ID
    delete process.env.NEXT_PUBLIC_META_APP_ID
    delete process.env.META_CONFIG_ID
    delete process.env.NEXT_PUBLIC_META_CONFIG_ID

    const res = await GET()
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.configured).toBe(false)
    expect(data.appId).toBe('')
    expect(data.configId).toBe('')
  })

  it('returns configured: true when server-side env vars are set', async () => {
    process.env.META_APP_ID = '111222333'
    process.env.META_CONFIG_ID = '444555666'

    const res = await GET()
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.configured).toBe(true)
    expect(data.appId).toBe('111222333')
    expect(data.configId).toBe('444555666')
    expect(data.graphVersion).toBe('v22.0')
  })

  it('prefers NEXT_PUBLIC_ variants when present', async () => {
    process.env.NEXT_PUBLIC_META_APP_ID = 'pub-app-id'
    process.env.META_APP_ID = 'srv-app-id'
    process.env.NEXT_PUBLIC_META_CONFIG_ID = 'pub-config-id'
    process.env.META_CONFIG_ID = 'srv-config-id'

    const res = await GET()
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.configured).toBe(true)
    expect(data.appId).toBe('pub-app-id')
    expect(data.configId).toBe('pub-config-id')
  })
})
