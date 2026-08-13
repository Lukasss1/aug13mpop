#!/usr/bin/env node
import { parseAndValidateSupabaseDbUrl } from './lib/supabase-db-target.mjs';
const ref=String(process.env.MP_SUPABASE_PROJECT_REF||'').trim();
const raw=String(process.env.SUPABASE_DB_URL||'').trim();
try { const x=parseAndValidateSupabaseDbUrl(raw,ref); console.log(`SUPABASE DB TARGET PASS — ${x.mode} ${x.host}:${x.port}/${x.database}`); }
catch(e){ console.error(`SUPABASE DB TARGET FAIL — ${e.message}`); process.exit(1); }
