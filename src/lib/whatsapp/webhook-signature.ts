import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   `META_APP_SECRET` is **required**. If it's missing we fail closed —
 *   every request is rejected until the operator configures the
 *   secret.
 *
 *   It may hold **several** secrets separated by commas (issue #500).
 *   Each Meta App signs with its own secret, so one deployment that
 *   receives webhooks from WABAs living under different Meta Apps needs
 *   to accept any of them. A request is valid when its signature
 *   matches ANY configured secret; each candidate is compared in
 *   constant time. See docs/multi-waba.md.
 */

/**
 * Split `META_APP_SECRET` into its candidate secrets: comma-separated,
 * trimmed of quotes/whitespace/newlines, empties dropped. Exported for tests.
 */
export function parseAppSecrets(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) =>
      s
        .replace(/[\r\n]+/g, '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim()
    )
    .filter((s) => s.length > 0)
}

function logSecretDiagnostics(secrets: string[]) {
  const envVal = process.env.META_APP_SECRET
  const isSet = Boolean(envVal && envVal.trim().length > 0)
  const lengths = secrets.map((s) => s.length)
  console.log(
    `[webhook signature config] env var name: META_APP_SECRET | is_set: ${isSet} | candidate count: ${secrets.length} | lengths: [${lengths.join(', ')}] (valid Meta App Secret is 32 hex chars)`
  )
}

function signatureMatches(
  rawBody: string | Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  // Strip "sha256=" prefix
  const cleanHeader = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7).trim()
    : signatureHeader.trim()

  const rawBytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody

  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBytes)
    .digest('hex')

  // Temporary debug log (never logging the secret):
  // - first 8 chars of expected signature
  // - first 8 chars of received signature
  // - body length
  console.log(
    `[webhook signature debug] body_length=${rawBytes.length}, received_sig=${cleanHeader.slice(0, 8)}..., expected_sig=${expectedHex.slice(0, 8)}..., secret_len=${secret.length}`
  )

  const a = Buffer.from(cleanHeader, 'hex')
  const b = Buffer.from(expectedHex, 'hex')

  // Bail if lengths differ or empty (timingSafeEqual throws otherwise)
  if (a.length !== b.length || a.length !== 32) return false
  return crypto.timingSafeEqual(a, b)
}

export function verifyMetaWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null,
): boolean {
  const secrets = parseAppSecrets(process.env.META_APP_SECRET)

  // Log diagnostics on whether META_APP_SECRET is set and its length
  logSecretDiagnostics(secrets)

  if (secrets.length === 0) {
    console.error(
      '[webhook] META_APP_SECRET is not set — rejecting request. ' +
        'Configure the env var (Meta → App Settings → Basic → App Secret) ' +
        'to enable signature verification.',
    )
    return false
  }

  if (secrets.includes('your-meta-app-secret')) {
    console.warn(
      '[webhook] META_APP_SECRET is set to placeholder "your-meta-app-secret" (length: 20) — ' +
        'signature verification will fail until set to your real Meta App Secret (should be 32 hex characters).'
    )
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  let ok = false
  for (const secret of secrets) {
    if (signatureMatches(rawBody, signatureHeader, secret)) ok = true
  }
  return ok
}
