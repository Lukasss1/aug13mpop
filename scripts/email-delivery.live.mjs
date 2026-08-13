#!/usr/bin/env node
/** Send one real provider-backed test email to the production owner's own DB address. */
const base=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const anon=process.env.SUPABASE_ANON_KEY||'';
const email=process.env.PRODUCTION_OWNER_EMAIL||'';
const password=process.env.PRODUCTION_OWNER_PASSWORD||'';
const origin=(process.env.MP_EXPECTED_ORIGIN||'').replace(/\/$/,'');
if(!base||!anon||!email||!password||!origin){console.error('SUPABASE_URL, SUPABASE_ANON_KEY, PRODUCTION_OWNER_EMAIL/PASSWORD and MP_EXPECTED_ORIGIN are required.');process.exit(2)}
async function signIn(){const r=await fetch(`${base}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},body:JSON.stringify({email,password})});if(!r.ok)throw new Error(`sign-in failed: HTTP ${r.status} ${await r.text()}`);return (await r.json()).access_token}
try{
  const token=await signIn();
  const r=await fetch(`${base}/functions/v1/send-email`,{method:'POST',headers:{apikey:anon,Authorization:`Bearer ${token}`,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({templateId:'test_email',recipient:{kind:'self'},params:{},brand:'Milk Pop',fromName:'Milk Pop'})});
  const text=await r.text();let body={};try{body=JSON.parse(text)}catch{}
  if(r.status!==200||body?.ok!==true)throw new Error(`provider-backed test email failed: HTTP ${r.status} ${text.slice(0,240)}`);
  console.log(`EMAIL DELIVERY LIVE PASS — provider accepted a test email for ${email.replace(/(^.).*(@.*$)/,'$1***$2')}`);
}catch(e){console.error(`EMAIL DELIVERY LIVE FAIL — ${e.message}`);process.exit(1)}
