-- ============================================================================
-- STAGE 3 / WS3b — CERTIFICATE UPDATE INTEGRITY (re-audit finding 1)
-- ============================================================================
-- The Round-3 trigger guarded INSERT only; a privileged user could create a
-- valid certificate and then UPDATE employee_id/assessment_id to a pair with
-- no passing result. The guard now runs on identity changes too, so the
-- invariant "no certificate without a matching passed result" holds for the
-- row's WHOLE LIFE, and certificate identity is effectively immutable unless
-- re-proven. Append-only re-issue; the Round-3 file stays frozen.
-- ============================================================================
drop trigger if exists trg_cert_requires_pass on training_certificates;
create trigger trg_cert_requires_pass
  before insert or update of employee_id, assessment_id on training_certificates
  for each row execute function cert_requires_pass();
