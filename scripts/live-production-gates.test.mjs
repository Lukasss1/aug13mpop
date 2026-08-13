#!/usr/bin/env node
import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';
const cors=readFileSync('scripts/edge-cors.live.mjs','utf8');const email=readFileSync('scripts/email-delivery.live.mjs','utf8');const outbox=readFileSync('scripts/outbox-delivery.live.mjs','utf8');const release=readFileSync('.github/workflows/release.yml','utf8');const backend=readFileSync('.github/workflows/commission-production-backend.yml','utf8');
const checks=[
 ['CORS probe covers public, upload and authenticated email functions',/public-form[\s\S]*cv-upload[\s\S]*send-email/.test(cors)],
 ['CORS probe rejects wildcard and untrusted origin',/untrusted[\s\S]*never emits wildcard/.test(cors)],
 ['email test uses server-side self template',/templateId:'test_email'[\s\S]*recipient:\{kind:'self'\}/.test(email)],
 ['email test requires provider success',/r\.status!==200\|\|body\?\.ok!==true/.test(email)],
 ['production e-mail/CORS probes reuse the real owner identity',/PRODUCTION_OWNER_EMAIL/.test(email) && /PRODUCTION_OWNER_PASSWORD/.test(email) && /PRODUCTION_OWNER_EMAIL/.test(cors) && /PRODUCTION_OWNER_PASSWORD/.test(cors)],
 ['outbox probe requires service-role delivery and cleanup',/SUPABASE_SERVICE_ROLE_KEY/.test(outbox) && /provider_message_id/.test(outbox) && /cleanup/.test(outbox)],
 ['outbox probe defaults to the real owner recipient without a separate privileged test identity',/PRODUCTION_OWNER_EMAIL/.test(outbox) && !/EMAIL_TEST_USER_/.test(outbox)],
 ['release workflow runs CORS, direct email and outbox live gates',/edge-cors\.live\.mjs[\s\S]*email-delivery\.live\.mjs[\s\S]*outbox-delivery\.live\.mjs/.test(release)],
 ['backend workflow runs CORS, direct email and outbox live gates',/edge-cors\.live\.mjs[\s\S]*email-delivery\.live\.mjs[\s\S]*outbox-delivery\.live\.mjs/.test(backend)],
];let p=0;for(const[n,c]of checks){try{assert.equal(c,true);p++;console.log(`PASS ${n}`)}catch{console.error(`FAIL ${n}`);process.exitCode=1}}if(!process.exitCode)console.log(`LIVE PRODUCTION GATES — ${p}/${checks.length} passed`);
