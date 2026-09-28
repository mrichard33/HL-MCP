/**
 * Appointment webhook payload reader — v2.3, 2026-09-28.
 *
 * GHL's app webhooks (AppointmentCreate / AppointmentUpdate / AppointmentDelete)
 * nest the record under `appointment`, with `type` and `locationId` on the
 * envelope. handleAppointmentWebhook read the top level, got no id, and its
 * upsert into appointments (ghl_appointment_id NOT NULL) failed with the error
 * unchecked — so the webhook path never wrote a single appointment and the
 * cache lagged GHL by up to one 15-minute sync. Seen as a false "missing from
 * GHL" page for SANDRA WATSON (PlB224EDUJYZJ2xnJ7mr, 2026-09-28): webhook at
 * 20:30:24Z wrote nothing; the 20:45 sync wrote the row.
 *
 * Pure: no Supabase, no network. The flat legacy shape is still accepted.
 */
import { toET } from '../utils/timezone.js';

export interface AppointmentWebhook {
  id: string;
  contactId: string | null;
  calendarId: string | null;
  locationId: string | null;
  title: string | null;
  status: string;
  startTime: string | null;
  endTime: string | null;
  assignedUserId: string | null;
  deleted: boolean;
  type: string;
  raw: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function readAppointmentWebhook(payload: Record<string, unknown>): AppointmentWebhook | null {
  const nested = payload.appointment;
  const inner = (nested && typeof nested === 'object' ? nested : payload) as Record<string, unknown>;
  const id = str(inner.id) || str(inner.appointmentId) || str(payload.appointmentId);
  if (!id) return null;
  const type = str(payload.type) || '';
  return {
    id,
    contactId: str(inner.contactId),
    calendarId: str(inner.calendarId),
    locationId: str(inner.locationId) || str(payload.locationId),
    title: str(inner.title),
    // Same precedence as syncAppointments' apptStatusOf (incl. the GHL typo).
    status: str(inner.appointmentStatus) || str(inner.appoinmentStatus) || str(inner.status) || 'confirmed',
    startTime: str(inner.startTime),
    endTime: str(inner.endTime),
    assignedUserId: str(inner.assignedUserId),
    deleted: type === 'AppointmentDelete' || inner.deleted === true,
    type,
    raw: inner,
  };
}

/**
 * Format a GHL time the way /calendars/events returns it (and so the way
 * syncAppointments hashes lead events): ET offset, whole seconds, no millis.
 *   "2026-09-30T18:00:00.000Z" → "2026-09-30T14:00:00-04:00"
 * Anything unparseable is returned unchanged.
 */
export function toSyncTimestamp(value: string | null): string | null {
  if (!value) return value;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return toET(ms).replace(/\.\d+(?=[+-]\d{2}:\d{2}$)/, '');
}
