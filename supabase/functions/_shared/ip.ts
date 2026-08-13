// Privacy-preserving network pseudonyms for anonymous abuse control.
export function clientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  const real = req.headers.get('x-real-ip');
  const forwarded = (req.headers.get('x-forwarded-for') || '').split(',')[0];
  return (cf || real || forwarded || 'unknown').trim().slice(0, 128);
}
export async function hmacIp(req: Request, secret: string, domain: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${domain}:${clientIp(req)}`));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
