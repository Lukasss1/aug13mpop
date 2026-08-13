# MILK POP — STAGING COMMISSIONING & LIVE CHECKS (R4.10)

The third external audit's final two blockers are **operational**, not code:
a fresh production-mode staging deployment (blocker 13) and a full
end-to-end live-check pass (blocker 14) before any public URL. This document
is those two checklists. Every box is checked by a person against the real
deployed system — no local harness satisfies any line here, by design: the
whole point is to catch what only production wiring can show.

Deploy staging using the environment and backend sequence in `PRODUCTION-COMMISSIONING-T13.3.30.md` — same
order, same secrets, same flags. Staging earns its name only if it is the
production procedure pointed at a different project.

---

## A. Staging commissioning (blocker 13)

- [ ] **Clean project.** A brand-new Supabase project — not the dev one, not
      a copy. `bash launch/migration-manifest.sh fresh` order applied with
      ON_ERROR_STOP; final count matches `… migrations | wc -l`.
- [ ] **Post-apply verifier.** `launch/verify-current-baseline.sql` passes
      against the staged database.
- [ ] **All 14 public website/staff Edge Functions deployed** from the release archive;
      `supabase functions list` shows those 14 and none of `pos-pair`, `pos-ingest` or `pos-catalog`; per-function JWT flags match
      the table in the runbook (spot-check public-form=false,
      send-email=true, request-seo-rebuild=true).
- [ ] **Secrets set** exactly as the runbook §2/§4: the three origin
      allow-lists carry the staging origin; Turnstile declared (either state,
      but declared); Resend key + EMAIL_FROM; SITE_URL; APP_ENV=production.
      There is no SEO hosting deploy-hook secret in T13.3.30. MEDIA_CLEANUP_ENABLED **absent**.
- [ ] **Scheduler live.** The outbox-dispatch cron exists and its logs show
      invocations at the 5-minute cadence.
- [ ] **Production-mode build** against the staging project succeeds — the
      env validator passes with rules HARD, and the SEO prerender reports
      `source=supabase` (never `development-defaults`; a fallback here is a
      commissioning FAILURE even though the pages would look fine).
- [ ] **Empty is a state, not an error.** With zero published content, every
      public page renders its designed empty state — no seed products, no
      fabricated news, no console errors, nothing in structured data or the
      sitemap that names unpublished commercial content.

## B. Live checks before a public URL (blocker 14)

Publication boundary, through the real UI as the real roles:

- [ ] Anonymous visitor sees **only** published content on menu, deals,
      news, careers, CMS pages and media — verified by publishing one item
      per collection in Admin and refreshing as a signed-out visitor.
- [ ] Each publish shows a truthful toast, flips the badge, and lands an
      `audit_logs` row; each **unpublish** removes the item from the public
      surface on refresh.
- [ ] A **store manager** account (AAL2) can publish/unpublish a menu item,
      sees **no** publish controls on the other five collections, and a
      direct RPC attempt on one of them is refused naming the owner.
- [ ] A manager at **AAL1** (before completing TOTP) cannot publish even the
      menu — the refusal names the second factor.
- [ ] **Stale-tab test:** open Admin in two tabs; create a product in tab A;
      save an unrelated menu edit from tab B — the save is refused as a
      stale snapshot and tab A's product survives. Re-hydrate B and repeat —
      it succeeds.
- [ ] **Completeness:** attempt to publish a menu item with no image — the
      refusal names the image; unpublishing it still works.

Launch facts and stores:

- [ ] Arming the public gates with an incomplete identity is refused,
      naming the missing fields; completing them and arming in one save
      succeeds.
- [ ] While armed, blanking `canonical_url` in Settings is refused; the
      telephone → "another channel serves instead" swap saves cleanly.
- [ ] A store cannot open before the gates are armed; a complete store
      opens after; blanking the open store's address is refused **without
      touching its status**; closing it first makes the same edit legal.

Forms, e-mail, SEO:

- [ ] With only the **contact** privacy notice published, the contact form
      accepts and the careers + franchise forms refuse naming **their own**
      notice only; publishing each notice unlocks exactly its own form.
- [ ] A submitted contact message arrives at the owner notification
      recipient via Resend (check the real inbox, not the logs), and the
      submission row carries the stamped notice version.
- [ ] Blanking the notification recipient closes all three forms; restoring
      it reopens them.
- [ ] Publishing a menu item records `SEO_REFRESH_PROTECTED_RELEASE` and does
      **not** trigger a hosting deploy. On the next protected signed staging
      release, the rebuilt sitemap/structured data includes the published item
      and **nothing** unpublished.
- [ ] Turnstile behaves as declared: enabled ⇒ a submission without a token
      is refused; disabled ⇒ forms work and the build recorded the explicit
      `false`.

Deferred surfaces stay deferred:

- [ ] Careers CV upload UI is absent (flag off) and `cv-upload` refuses a
      direct call from a non-allow-listed origin.
- [ ] Media library upload UI shows the disabled state; `media-cleanup`
      invoked manually reports itself inert.
- [ ] No POS pairing surface is reachable from the website.

Sign-off: date, archive SHA-256, staging project ref, and the name of the
person who walked both lists — recorded next to the release manifest.
