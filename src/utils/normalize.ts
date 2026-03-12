/**
 * Shared normalization functions for GHL API data.
 *
 * The GHL API returns direction as either a string ('inbound'/'outbound')
 * or a numeric value (1 = inbound, 2 = outbound) depending on the channel.
 * The n8n workflow already handles this — this utility centralises the logic
 * for the TypeScript sync and webhook paths.
 */

export function normalizeDirection(raw: string | number | undefined | null): 'inbound' | 'outbound' {
  if (raw === 'inbound' || raw === 1) return 'inbound';
  return 'outbound';
}

/**
 * Extract message body from various GHL payload shapes.
 * Standard messages use `body`; live chat may use `message` or `text`.
 */
export function extractMessageBody(msg: Record<string, unknown>): string | null {
  const body = msg.body || msg.message || msg.text;
  return typeof body === 'string' ? body : null;
}
