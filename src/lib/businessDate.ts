/* ----------------------------------------------------------------------------
 * businessDate — the ONE browser source of the store business date (WS6g).
 * ----------------------------------------------------------------------------
 * The server derives VAT charging from `(now() at time zone store.timezone)`;
 * Round-9e audit item 4: the browser must use the SAME authoritative
 * Europe/London business date, not the UTC calendar date. During BST the two
 * diverge between 23:00 and 00:00 UTC — exactly when a late till session
 * would mis-render whether VAT applies.
 *
 * Display-only: the server remains the sole authority for every stored
 * figure; this keeps the till's rendering in agreement with it.
 * ------------------------------------------------------------------------- */

/** ISO `YYYY-MM-DD` for an instant in the store's business timezone.
 *  Returns an empty string for an invalid instant so a malformed timestamp can
 *  never be counted as today's sale. Falls back to the instant's UTC date only
 *  if Intl rejects the zone — unreachable for commissioned store rows because
 *  their timezone is database constrained. */
export function businessDateISOAt(instant: Date | string | number, timezone?: string | null): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) return '';
  const tz = timezone || 'Europe/London';
  try {
    // Build ISO explicitly from parts. Depending on the host ICU data, even an
    // `en-CA` formatter is allowed to choose a different separator/order.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get('year');
    const month = values.get('month');
    const day = values.get('day');
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Invalid/unavailable timezones fall back to the same instant in UTC. Store
    // timezone rows are database-constrained, but this keeps stale client data
    // from crashing a read-only dashboard.
  }
  return date.toISOString().slice(0, 10);
}

/** ISO `YYYY-MM-DD` of "today" in the store's business timezone. */
export function businessTodayISO(timezone?: string | null): string {
  return businessDateISOAt(new Date(), timezone);
}

/** The server's charging predicate, mirrored for display: REGISTERED AND the
 *  registration's effective date has arrived in the store's business day. */
export function isVatCharging(store?: {
  vatStatus?: string;
  vatRegistrationEffectiveDate?: string | null;
  timezone?: string | null;
} | null): boolean {
  if (!store || store.vatStatus !== 'REGISTERED') return false;
  const eff = store.vatRegistrationEffectiveDate;
  return !!eff && eff <= businessTodayISO(store.timezone);
}

/** Milliseconds until the next business-day boundary in `timezone`, clamped to
 *  a sane window. Used to schedule a recalculation so an open till does not
 *  keep yesterday's date past midnight. */
export function msUntilNextBusinessDay(timezone?: string | null): number {
  const today = businessTodayISO(timezone);
  // Walk forward in coarse steps, then refine — avoids per-zone DST arithmetic.
  const now = Date.now();
  let lo = 0;
  let hi = 26 * 60 * 60 * 1000;              // a day plus DST slack
  if (businessTodayISO(timezone) !== today) return 0;
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const probe = businessDateISOAt(now + mid, timezone);
    if (probe === today) lo = mid; else hi = mid;
  }
  return Math.max(hi, 1000) + 1000;          // just past the boundary
}
