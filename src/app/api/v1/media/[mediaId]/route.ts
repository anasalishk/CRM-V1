// ============================================================
// GET /api/v1/media/{mediaId} — download an inbound media file
// (image, document, …) by its Meta media id, using the account's own
// WhatsApp token. Scope: messages:read (messages:send also accepted,
// so a bot key that sends and reads attachments needs one key).
//
// Meta only resolves media ids that belong to the token's WhatsApp
// account, so one account can't fetch another's media.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { hasScope } from '@/lib/api-keys/scopes';
import { fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

const MAX_BYTES = 16 * 1024 * 1024;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const ctx = await requireApiKey(request);
    if (!hasScope(ctx.scopes, 'messages:read') && !hasScope(ctx.scopes, 'messages:send')) {
      return fail('forbidden', "This API key is missing the 'messages:read' scope", 403);
    }
    const { mediaId } = await params;
    if (!/^\d{5,40}$/.test(String(mediaId || ''))) {
      return fail('validation_error', 'Invalid media id', 400);
    }

    const { data: config } = await ctx.supabase
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!config?.access_token) {
      return fail('not_configured', 'WhatsApp is not configured for this account', 400);
    }
    const accessToken = decrypt(config.access_token);

    let info;
    try {
      info = await getMediaUrl({ mediaId, accessToken });
    } catch {
      return fail('not_found', 'Media not found', 404);
    }
    if (info.fileSize && info.fileSize > MAX_BYTES) {
      return fail('too_large', 'Media file is too large', 413);
    }
    const { buffer, contentType } = await downloadMedia({ downloadUrl: info.url, accessToken });
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || info.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
