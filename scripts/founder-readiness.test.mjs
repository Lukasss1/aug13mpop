#!/usr/bin/env node
/**
 * Founder-readiness regression gate.
 *
 * Static and dependency-free by design: it protects the owner-facing fixes even
 * when the clean npm/browser lane is unavailable. It does not replace typecheck,
 * build or browser testing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const messages = read('src/lib/operatorMessages.ts');
const notify = read('src/lib/notify.ts');
const academy = read('src/components/AcademyStudio.tsx');
const errorBoundary = read('src/components/AppErrorBoundary.tsx');
const studio = read('src/components/admin/WebsiteStudio.tsx');
const admin = read('src/components/AdminPanel.tsx');
const dashboard = read('src/components/admin/DashboardPanel.tsx');
const closure = read('src/components/admin/ClosurePanels.tsx');
const publicPages = read('src/components/PublicPages.tsx');
const css = read('src/index.css');

check('cloud configuration guidance has a stable owner-safe issue code',
  /cloudNotConfigured:\s*'MP-CLD-001'/.test(messages)
  && /Contact technical support and quote/.test(messages));
check('e-mail and Academy reuse the same cloud guidance',
  /cloudNotConfiguredMessage\('E-mail sending'\)/.test(notify)
  && /cloudNotConfiguredMessage\('Training video uploads'\)/.test(academy));
check('misleading Company Settings cloud instructions are removed',
  !/connect it in Company Settings/i.test(notify + academy));

check('Website Studio protects a dirty draft before browser unload',
  /addEventListener\('beforeunload', protectDraft\)/.test(studio)
  && /removeEventListener\('beforeunload', protectDraft\)/.test(studio)
  && /event\.returnValue = ''/.test(studio));
check('Website Studio keeps clean-state publish controls out of the focus order',
  /\{requiresOwnerAction && \(\s*<div className="fixed bottom-4/.test(studio)
  && !/pointer-events-none'\}`/.test(studio));
check('Website Studio can retry image-reference finalisation without a cosmetic republish',
  /const hasPendingImageFinalisation = pendingAttachmentFailures > 0/.test(studio)
  && /if \(isDirty\) \{\s*await doPublish\(\);\s*\} else \{\s*const failures = await finaliseImageReferences\(\)/s.test(studio)
  && /Retry image references/.test(studio)
  && /requiresOwnerAction/.test(studio));
check('Website Studio retains a shared image until every field reference is finalised',
  /const referencesByUrl = new Map<string, \{ objectId: string; fields: string\[\] \}>/.test(studio)
  && /const failedForUrl = outcomes\.filter\(\(attached\) => !attached\)\.length/.test(studio)
  && /if \(failedForUrl === 0\) uploadedObjectIds\.current\.delete\(url\)/.test(studio));
check('Website Studio preserves upload references across Admin tab switches',
  /interface StudioStash[\s\S]*uploadedObjectIds: Map<string, string>/.test(studio)
  && /draftScopeKey: string/.test(studio)
  && /new Map\(restorableStash\?\.uploadedObjectIds/.test(studio));
check('Website Studio removes unpublished upload bookkeeping when a draft is discarded',
  /const liveReferences = collectImageReferences\(content\)/.test(studio)
  && /if \(!liveReferences\.has\(url\)\) uploadedObjectIds\.current\.delete\(url\)/.test(studio)
  && /setPendingAttachmentFailures\(remainingReferenceCount\)/.test(studio));
check('Website Studio aligns its local draft with normalised published settings',
  /if \(settingsNext\) setSettingsDraft\(pickStudioSettings\(settingsNext\)\)/.test(studio));
check('Website Studio exposes unsaved state to assistive technology',
  /role="status" aria-live="polite"/.test(studio));
check('Website Studio refresh guidance matches the protection',
  /browser warns before a refresh/.test(studio)
  && !/page refresh discards them/.test(studio));

check('e-mail preferences are explicit-save, not described as automatic',
  /Unsaved changes — save your preferences/.test(admin)
  && /Saved preferences are active/.test(admin)
  && !/Preferences save automatically/.test(admin));
check('test e-mail is disabled while settings have not been saved',
  /disabled=\{emailBusyId === '__test__' \|\| emailDraftDirty\}/.test(admin));
check('cloud degradation links to the real dashboard health panels',
  /const openSystemStatus = useCallback/.test(admin)
  && /onClick=\{openSystemStatus\}/.test(admin)
  && /Open system status/.test(admin)
  && /id="system-status"/.test(dashboard)
  && /section\?\.focus\(\{ preventScroll: true \}\)/.test(admin)
  && !/Technical health/.test(admin));
check('system status provides a privacy-safe support summary',
  /Copy status/.test(closure)
  && /Milk Pop system status/.test(closure)
  && /signal\.key}: \${signal\.state}/.test(closure)
  && !/signal\.value}:|signal\.note}/.test(closure));
check('root failure screen exposes a stable support reference without raw data',
  /MP-UI-/.test(errorBoundary)
  && /Copy support reference/.test(errorBoundary)
  && /VITE_RELEASE_IDENTITY/.test(errorBoundary)
  && /role="status" aria-live="polite"/.test(errorBoundary)
  && !/location\.search|location\.hash/.test(errorBoundary));

check('allergen copy matches the commissioned in-store mode',
  /configured allergen mode; this release uses in-store disclosure/.test(closure)
  && /do not present the public menu as a complete online allergen declaration/.test(studio));
check('semantic supporting text has a deterministic readable size',
  /\.text-2xs\s*\{[^}]*font-size:\s*0\.75rem;[^}]*line-height:\s*1rem;/s.test(css));
check('active icon-only owner and staff controls have accessible names',
  /aria-label={`Move question \$\{i \+ 1\} up`}/.test(academy)
  && /aria-label="Close employee record"/.test(admin)
  && /aria-label="Clear website search"/.test(studio)
  && /aria-label="Show earlier rota days"/.test(read('src/components/staff/StaffDashboardPanel.tsx'))
  && /aria-label={`Send management response for incident \$\{report\.id\}`}/.test(read('src/components/staff/StaffSifrPanel.tsx')));
check('Website Studio fields have deterministic accessible labels',
  /const fieldId = controlId\('studio-field', field\.path\)/.test(studio)
  && /<label htmlFor=\{fieldId\}/.test(studio)
  && /<textarea id=\{fieldId\}/.test(studio)
  && /<input id=\{fieldId\}/.test(studio)
  && /aria-label="Search website fields"/.test(studio));
check('core founder forms associate visible labels with their controls',
  /htmlFor="entity-menu-name"/.test(admin)
  && /id="entity-menu-name"/.test(admin)
  && /htmlFor="entity-store-name"/.test(admin)
  && /id="entity-staff-email"/.test(admin)
  && /htmlFor="shift-date"/.test(admin)
  && /htmlFor="academy-module-title"/.test(academy)
  && /id="academy-assignment-due"/.test(academy));
check('public vacancy cards use one semantic navigation target',
  /<a[\s\S]*href=\{routeToPath\('careers', \{ job: vacancySlug\(job\) \}\)\}[\s\S]*onClick=\{\(event\) => handleAnchorNav\(event,/.test(publicPages)
  && !/<div[^>]*onClick=[^>]*>[\s\S]{0,800}<a/.test(publicPages));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} — ${item.name}`);
console.log(`\nFOUNDER READINESS — ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
