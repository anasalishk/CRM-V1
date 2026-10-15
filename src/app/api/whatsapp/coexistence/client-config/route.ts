import { NextResponse } from 'next/server'

/**
 * GET /api/whatsapp/coexistence/client-config
 *
 * Exposes the public Meta App ID and Embedded Signup Login Configuration ID
 * needed by the Facebook JavaScript SDK in the browser.
 * Reads from either NEXT_PUBLIC_* or server-side META_* env vars so operators
 * don't need redundant prefixed env declarations.
 */
export async function GET() {
  const appId =
    process.env.NEXT_PUBLIC_META_APP_ID ||
    process.env.META_APP_ID ||
    ''

  const configId =
    process.env.NEXT_PUBLIC_META_CONFIG_ID ||
    process.env.META_CONFIG_ID ||
    ''

  const graphVersion = process.env.GRAPH_API_VERSION || 'v22.0'

  return NextResponse.json({
    appId,
    configId,
    graphVersion,
    configured: Boolean(appId && configId),
  })
}
