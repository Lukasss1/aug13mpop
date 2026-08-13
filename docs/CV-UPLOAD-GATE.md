# CV upload gate (R4.8, Workstream L — launch-safe default OFF)

`CAREERS_CV_UPLOAD` defaults **false**; the careers form is fully functional
without attachments and the admin inbox shows that no attachment was
requested. `scripts/validate-deployment-env.mjs` refuses
`CAREERS_CV_UPLOAD=true` in production unless `CV_SCANNER_ATTESTED=true`.

Before the flag may ever be enabled, ALL of the following must be implemented
and evidenced (none are shipped as complete in R4.8):

1. Strict OOXML validation (a generic ZIP is NOT a DOCX; expected package
   entries verified; malformed/encrypted/unsupported archives rejected).
2. Content-Length early rejection; rejected abuse consumes rate-limit budget.
3. Turnstile fail-closed (already enforced in `cv-upload` as of R4.8).
4. Quarantine state + malware-scanning provider; object not retrievable until
   scan-clean; provider/result/timestamp recorded; rejected objects deleted.
5. Private storage + short-lived signed URLs (already the house model) and an
   audited staff-download trail.
6. The malformed/fake/oversized/polyglot/duplicate/simulated-malware test set.

Where no scanner is configured, the feature stays disabled. This is the
*intentionally disabled* classification in the closure report.
