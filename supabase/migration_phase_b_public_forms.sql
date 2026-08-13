-- ============================================================================
--  MILK POP — MIGRATION B1 (PHASE B): PUBLIC-FORM DIRECT-INSERT LOCKOUT
--
--  Run order: after schema.sql, migration_security_lockdown.sql (if used),
--             migration_rls_per_role.sql and migration_public_form_guard.sql.
--  Safe to re-run: every statement is drop-if-exists / revoke (idempotent).
--
--  WHAT THIS DOES
--  --------------
--  Until now the three public form tables (job_applications,
--  franchise_inquiries, contact_messages) carried a `public_insert` RLS
--  policy allowing a direct anonymous INSERT. That policy existed only as a
--  fallback for deployments without the `public-form` Edge Function — and a
--  direct INSERT bypasses everything the function enforces: field
--  allow-listing + length validation, the per-IP rate limit, and CAPTCHA.
--
--  PHASE B closes that path on BOTH sides:
--   • the client no longer falls back to a direct INSERT
--     (src/lib/supabase.ts submitPublicForm), and
--   • THIS migration removes the database policy + grants, so a handcrafted
--     REST request is rejected by RLS regardless of what any client does.
--
--  The Edge Function is unaffected: it inserts with the SERVICE ROLE key,
--  which bypasses RLS by design. Deny-by-default continues to protect every
--  other action (no SELECT/UPDATE/DELETE policy exists for these tables for
--  anon, so those were already denied).
--
--  VERIFICATION (Phase C live run):
--    scripts/public-form-rejection.live.mjs — proves an anon-key REST INSERT
--    into each table returns 401/403, while the Edge Function path succeeds.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'job_applications','franchise_inquiries','contact_messages'
  ] loop
    -- 1. Remove the anon/authenticated direct-INSERT policy.
    execute format('drop policy if exists public_insert on %I', t);

    -- 2. Belt-and-braces: also revoke the table-level INSERT grant from the
    --    API roles. RLS already denies without a policy, but revoking the
    --    grant means even a future accidental policy cannot silently re-open
    --    the path without an explicit re-grant appearing in a migration.
    execute format('revoke insert on %I from anon', t);
    execute format('revoke insert on %I from authenticated', t);
  end loop;
end $$;

-- The tables stay readable to the signed-in inbox reviewers exactly as
-- migration_inbox_read.sql configured them — nothing here touches SELECT.

-- ---------------------------------------------------------------------------
-- HANDOVER NOTE
-- ---------------------------------------------------------------------------
-- After applying this file, the ONLY way a public visitor's submission reaches
-- the database is: browser → /functions/v1/public-form → (validate fields,
-- rate-limit, CAPTCHA) → service-role INSERT. If the function is down the
-- website shows a controlled "try again shortly" error and writes nothing.
