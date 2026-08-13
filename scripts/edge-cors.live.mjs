#!/usr/bin/env node
/** Live production proof that Edge Function CORS is exact-origin and fail-closed. */
const base=(process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL||'').replace(/\/$/,'');
const anon=process.env.SUPABASE_ANON_KEY||process.env.VITE_SUPABASE_ANON_KEY||'';
const expected=(process.env.MP_EXPECTED_ORIGIN||'').replace(/\/$/,'');
const email=process.env.PRODUCTION_OWNER_EMAIL||'';
const password=process.env.PRODUCTION_OWNER_PASSWORD||'';
if(!base||!anon||!/^https:\/\//.test(expected)||!email||!password){
  console.error('SUPABASE_URL, SUPABASE_ANON_KEY, MP_EXPECTED_ORIGIN and PRODUCTION_OWNER_EMAIL/PASSWORD are required.');process.exit(2);
}
let pass=0,fail=0;const check=(n,c,d='')=>{if(c){pass++;console.log(`PASS ${n}`)}else{fail++;console.error(`FAIL ${n}${d?` — ${d}`:''}`)}};
async function signIn(){
  const r=await fetch(`${base}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  if(!r.ok)throw new Error(`CORS probe sign-in failed: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}
async function options(name,origin,token=''){
  return fetch(`${base}/functions/v1/${name}`,{method:'OPTIONS',headers:{apikey:anon,Origin:origin,'Access-Control-Request-Method':'POST',...(token?{Authorization:`Bearer ${token}`}:{})}});
}
try{
  const token=await signIn();
  for(const [fn,auth] of [['public-form',''],['cv-upload',''],['send-email',token]]){
    const trusted=await options(fn,expected,auth);
    check(`${fn} echoes the configured production origin`,trusted.headers.get('access-control-allow-origin')===expected,`HTTP ${trusted.status}; ACAO=${trusted.headers.get('access-control-allow-origin')}`);
    const evil=await options(fn,'https://untrusted.example.invalid',auth);
    const acao=evil.headers.get('access-control-allow-origin');
    check(`${fn} refuses an untrusted browser origin`,acao===null||acao==='null',`HTTP ${evil.status}; ACAO=${acao}`);
    check(`${fn} never emits wildcard CORS in production`,acao!=='*'&&trusted.headers.get('access-control-allow-origin')!=='*');
  }
}catch(e){console.error(`LIVE CORS ERROR: ${e.message}`);process.exit(2)}
console.log(`EDGE CORS LIVE — ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
