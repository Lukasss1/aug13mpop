# Build Required — T13.3.30 Source Candidate

This is the T13.3.30 protected-deployment-closure source candidate `r4.10.15-t13.3.30-final-production-closure`, containing **107 ordered upgrade migrations**, **109 fresh-install SQL entries** and a **17-function** source inventory. Public launch deploys exactly **14 website/staff functions**; the three POS functions remain undeployed.

This package is source, not a prebuilt production website. The production `dist/` must be generated from the exact committed source with the locked toolchain and production environment, then sealed, signed and deployed by the protected GitHub release workflow.

Do not reuse an old `dist/`, upload this source ZIP directly to Netlify, manually paste the migration chain into Supabase, or publish from a local workstation.

Before production mutation, the protected workflow must prove the current `release-manifest.json` source digest, run the PostgreSQL 17 rehearsal, validate protected inputs and verify the exact Supabase target. The current operator authority is [`PRODUCTION-COMMISSIONING-T13.3.30.md`](PRODUCTION-COMMISSIONING-T13.3.30.md).
