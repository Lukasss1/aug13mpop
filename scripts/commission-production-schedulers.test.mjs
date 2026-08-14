#!/usr/bin/env node
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const dir=mkdtempSync(join(tmpdir(),'mp-scheduler-test-'));
const capture=join(dir,'sql.txt');
const fake=join(dir,'psql');
writeFileSync(fake,`#!/usr/bin/env bash\ncat > "${capture}"\necho SCHEDULER_ROWS_OK\n`,{mode:0o755});chmodSync(fake,0o755);
let called=false;
const server=http.createServer(async(req,res)=>{for await(const _ of req){};called=true;res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
// URL validation intentionally requires a Supabase hostname; intercept fetch by
// mapping that hostname to the local mock through NODE_OPTIONS is inappropriate,
// so test the SQL/secret boundary using a tiny source copy with the URL guard
// replaced only inside this temporary test process.
// eslint-disable-next-line no-useless-escape -- this string matches regex source text byte-for-byte.
const source=readFileSync('scripts/commission-production-schedulers.mjs','utf8').replace("if (!/^https:\\\/\\\\/[a-z0-9]{20}\\\\.supabase\\\\.co$/.test(projectUrl)) {","if (false) {");
mkdirSync(join(dir,'lib'),{recursive:true}); copyFileSync('scripts/lib/supabase-db-target.mjs',join(dir,'lib/supabase-db-target.mjs'));
const runner=join(dir,'runner.mjs');writeFileSync(runner,source.replace("await fetch(`${projectUrl}/functions/v1/outbox-dispatch`",`await fetch('http://127.0.0.1:${port}/functions/v1/outbox-dispatch'`));
const child=spawn(process.execPath,[runner],{cwd:process.cwd(),env:{...process.env,SUPABASE_DB_URL:'postgresql://postgres:dbpass@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'scheduler-secret-value',MP_PSQL_BIN:fake},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);const code=await new Promise(r=>child.on('close',r));server.close();
const sql=readFileSync(capture,'utf8');let p=0;const check=(n,c)=>{assert.equal(c,true,n);p++;console.log(`PASS ${n}`)};
check('commissioner exits successfully',code===0);
check('all four exact job names are scheduled',/outbox-dispatch/.test(sql)&&/employment-sweep/.test(sql)&&/retention-sweep/.test(sql)&&/ops-health-watch/.test(sql));
check('scheduler credentials are stored through Vault',/vault\.create_secret/.test(sql)&&/vault\.update_secret/.test(sql)&&/vault\.decrypted_secrets/.test(sql));
check('cron command does not contain the literal test secret outside Vault statements',!(/Authorization[^\n]*scheduler-secret-value/.test(sql)));
check('outbox worker is invoked immediately',called&&/PRODUCTION SCHEDULERS PASS/.test(out));
check('credentials are absent from process output',!out.includes('scheduler-secret-value')&&!err.includes('scheduler-secret-value')&&!out.includes('dbpass')&&!err.includes('dbpass'));
rmSync(dir,{recursive:true,force:true});console.log(`PRODUCTION SCHEDULER COMMISSION CONTRACT — ${p}/${p} passed`);
