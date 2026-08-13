/** Exact Supabase Postgres target binding for destructive/commissioning paths. */
export function parseAndValidateSupabaseDbUrl(raw, expectedRef) {
  if (!expectedRef || !/^[a-z0-9]{20}$/.test(expectedRef)) throw new Error('expected project ref is malformed');
  let u;
  try { u = new URL(raw); } catch { throw new Error('SUPABASE_DB_URL is not a valid URL'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('SUPABASE_DB_URL must use postgres/postgresql');
  const db = u.pathname.replace(/^\//, '') || 'postgres';
  if (db !== 'postgres') throw new Error('SUPABASE_DB_URL must target database postgres');
  const port = u.port || '5432';
  const user = decodeURIComponent(u.username || '');
  const host = u.hostname.toLowerCase();
  const directHost = `db.${expectedRef}.supabase.co`;
  const direct = host === directHost && user === 'postgres' && port === '5432';
  const sessionPooler = host.endsWith('.pooler.supabase.com') && user === `postgres.${expectedRef}` && port === '5432';
  if (!direct && !sessionPooler) {
    throw new Error('SUPABASE_DB_URL is not the confirmed project direct endpoint or Session Pooler (port 5432)');
  }
  return { url: u, mode: direct ? 'direct' : 'session-pooler', host, port, database: db, user };
}
