#!/usr/bin/env node
import { parseAndValidateSupabaseDbUrl as v } from './lib/supabase-db-target.mjs';
const ref='abcdefghijklmnopqrst'; let p=0,f=0; const ck=(n,fn,ok=true)=>{try{fn(); if(ok){p++;console.log('✓ '+n)}else{f++;console.error('✗ '+n)}}catch(e){if(!ok){p++;console.log('✓ '+n)}else{f++;console.error('✗ '+n+' — '+e.message)}}};
ck('direct exact target accepted',()=>v(`postgresql://postgres:p@db.${ref}.supabase.co:5432/postgres`,ref));
ck('session pooler exact user/ref accepted',()=>v(`postgresql://postgres.${ref}:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,ref));
ck('wrong project ref in pooler username rejected',()=>v('postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres',ref),false);
ck('transaction pooler port rejected for session-lock deployment',()=>v(`postgresql://postgres.${ref}:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,ref),false);
ck('substring decoy in password does not satisfy target binding',()=>v(`postgresql://postgres:${ref}@db.wrongwrongwrongwrongwr.supabase.co:5432/postgres`,ref),false);
console.log(`\nSupabase DB target: ${p}/${p+f} checks passed.`); if(f)process.exit(1);
