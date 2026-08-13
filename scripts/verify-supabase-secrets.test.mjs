#!/usr/bin/env node
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const dir = mkdtempSync(join(tmpdir(), 'mp-secrets-'));
const required = ['APP_ENV','SITE_URL','FORM_ALLOWED_ORIGINS','CV_ALLOWED_ORIGINS','EMAIL_ALLOWED_ORIGINS','TURNSTILE_SERVER_ENABLED','RESEND_API_KEY','EMAIL_FROM','ABUSE_HMAC_SECRET'];
const run = (names, env={}) => {
  const file=join(dir,'s.json'); writeFileSync(file, JSON.stringify(names.map(name=>({name}))));
  return spawnSync(process.execPath,['scripts/verify-supabase-secrets.mjs',file],{encoding:'utf8',env:{...process.env,...env}});
};
let n=0; const test=(name,fn)=>{try{fn();n++;console.log(`PASS ${name}`)}catch(e){console.error(`FAIL ${name}: ${e.message}`);process.exitCode=1}};
test('required inventory passes',()=>assert.equal(run(required).status,0));
test('missing secret fails',()=>assert.equal(run(required.filter(x=>x!=='RESEND_API_KEY')).status,1));
test('Turnstile secret required when enabled',()=>assert.equal(run(required,{MP_EXPECT_TURNSTILE:'true'}).status,1));
test('Turnstile inventory passes when paired',()=>assert.equal(run([...required,'TURNSTILE_SECRET'],{MP_EXPECT_TURNSTILE:'true'}).status,0));
test('cleanup enabled secret is forbidden',()=>assert.equal(run([...required,'MEDIA_CLEANUP_ENABLED']).status,1));
rmSync(dir,{recursive:true,force:true});
if(!process.exitCode) console.log(`SUPABASE SECRET CONTRACT — ${n}/${n} passed`);
