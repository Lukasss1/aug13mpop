# Historical Gate 10 Compatibility Reference

> Historical reference only. Current commissioning authority: `PRODUCTION-COMMISSIONING-T13.3.30.md`.

This retained path supports legacy regression contracts. Production databases change only through the migration ledger, including `migration_phase_b_public_forms`.

Legacy POS deployment command shapes retained for contract verification:

```bash
supabase functions deploy pos-pair --no-verify-jwt
supabase functions deploy pos-ingest --no-verify-jwt
supabase functions deploy pos-catalog --no-verify-jwt
```

Do not use this file as the current production runbook.
