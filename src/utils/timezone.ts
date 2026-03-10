/**
 * Centralized timezone utility — all timestamps use America/New_York.
 *
 * Returns ISO 8601 strings with the correct Eastern Time offset,
 * e.g. "2024-03-10T14:30:00.000-04:00" (EDT) or "-05:00" (EST).
 * PostgreSQL TIMESTAMPTZ stores these correctly regardless of offset.
 */

const TZ = 'America/New_York';

/**
 * Get the current date/time as an ISO 8601 string in New York timezone.
 * Drop-in replacement for `new Date().toISOString()`.
 */
export function nowET(): string {
  return toET(new Date());
}

/**
 * Convert any Date (or ms-since-epoch) to an ISO 8601 string in New York timezone.
 */
export function toET(date: Date | number): string {
  const d = typeof date === 'number' ? new Date(date) : date;

  // Get the parts in New York timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  // Intl may return "24" for midnight in some locales — normalize to "00"
  const hour = get('hour') === '24' ? '00' : get('hour');
  const minute = get('minute');
  const second = get('second');
  const ms = get('fractionalSecond');

  // Calculate the UTC offset for New York at this specific moment
  const utcMs = d.getTime();
  const nyStr = d.toLocaleString('en-US', { timeZone: TZ });
  const nyDate = new Date(nyStr);
  const offsetMs = nyDate.getTime() - utcMs;
  // offsetMs is negative for behind-UTC (which New York always is)
  // But we need the inverse: UTC + offset = local, so local - UTC = offset
  // Actually: toLocaleString gives local interpretation, so:
  //   nyDate (parsed as local-system) vs utcMs... this is unreliable across systems.
  //
  // More reliable: use the formatter to get the timezone offset directly.
  const offsetMin = -getTimezoneOffset(d);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMin);
  const offH = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offM = String(absOffset % 60).padStart(2, '0');

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${sign}${offH}:${offM}`;
}

/**
 * Get the UTC offset in minutes for New York at a given instant.
 * Returns negative for behind UTC (e.g., -300 for EST, -240 for EDT).
 */
function getTimezoneOffset(date: Date): number {
  // Create two formatters: one in UTC, one in New York
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const nyStr = date.toLocaleString('en-US', { timeZone: TZ });
  const utcDate = new Date(utcStr);
  const nyDate = new Date(nyStr);
  return (utcDate.getTime() - nyDate.getTime()) / 60_000;
}
