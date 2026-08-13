// Encode a Supabase Storage object key without collapsing its folder layout.
// Object paths come from server-owned metadata, but individual segments may
// still contain spaces or URL-reserved characters. Encoding at the HTTP edge
// prevents a valid database key from becoming a different request path.
export function encodeStoragePath(objectPath: string): string {
  return objectPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}
