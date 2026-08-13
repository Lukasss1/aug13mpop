// HS256 JWT mint for the LOCAL stack only. Usage: node mint.mjs <role> [json-extra]
import { createHmac } from 'node:crypto';
const b64u = (b) => Buffer.from(b).toString('base64url');
const [role, extra] = process.argv.slice(2);
const secret = process.env.PGRST_JWT_SECRET;
const payload = { role, exp: Math.floor(Date.now() / 1000) + 3600, ...(extra ? JSON.parse(extra) : {}) };
const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const body = b64u(JSON.stringify(payload));
const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
console.log(`${head}.${body}.${sig}`);
