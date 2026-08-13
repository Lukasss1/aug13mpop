// Mini-Kong for the LOCAL stack: one origin (:54321) fronting PostgREST and
// the three real Edge Functions, plus a one-endpoint GoTrue stand-in that
// signs the owner JWT the same way production GoTrue would.
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const REST = 'http://127.0.0.1:3000';
const FNS = { 'pos-pair': 9101, 'pos-ingest': 9102, 'pos-catalog': 9103 };
const ownerJwt = () => spawnSync('node', [new URL('./mint.mjs', import.meta.url).pathname,
  'authenticated', JSON.stringify({ app_role: 'owner', staff_store: 'HQ', staff_id: 'emp_e2e_owner',
    sub: '00000000-0000-0000-0000-000000000001' })],
  { env: process.env, encoding: 'utf8' }).stdout.trim();

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/auth/v1/token')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: ownerJwt(), token_type: 'bearer' }));
      return;
    }
    let target = null;
    if (url.pathname.startsWith('/rest/v1/')) {
      target = `${REST}${url.pathname.slice('/rest/v1'.length)}${url.search}`;
    } else if (url.pathname.startsWith('/functions/v1/')) {
      const fn = url.pathname.split('/')[3];
      if (FNS[fn]) target = `http://127.0.0.1:${FNS[fn]}${url.search}`;
    }
    if (!target) { res.writeHead(404); res.end('{"error":"no route"}'); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    const upstream = await fetch(target, {
      method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const outHeaders = {};
    upstream.headers.forEach((v, k) => { if (k !== 'transfer-encoding' && k !== 'content-encoding') outHeaders[k] = v; });
    res.writeHead(upstream.status, outHeaders);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
}).listen(54321, () => console.log('gateway :54321'));
