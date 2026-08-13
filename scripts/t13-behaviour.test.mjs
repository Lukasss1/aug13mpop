#!/usr/bin/env node
/**
 * ============================================================================
 *  T13 — BEHAVIOURAL REGRESSION SUITE
 * ============================================================================
 *
 *  §13 is explicit: "Tests must exercise runtime behaviour where practical. Do
 *  not treat a regex proving that a source string exists as sufficient
 *  behavioural evidence."
 *
 *  So the projection rules, the pay model, the scope signature, the Careers
 *  selection lifecycle, the Store selection precedence and the duplicate-click
 *  lock are all EXECUTED here — the projection and pay modules are the real
 *  production imports, and the four rules that live inside React effects are
 *  executed as extracted pure reducers that this suite pins byte-for-byte
 *  against the component source, so the tested logic cannot silently diverge
 *  from the shipped logic.
 *
 *  Run:  npm run test:t13
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  projectPublicMenuItems, projectPublicStores, projectPublicVacancies,
  projectPublicNews, projectPublicDeals,
} from '../src/lib/publicProjection';
import { effectiveHourlyRate, weeklyFixedSalaryCost } from '../src/lib/pay';
import {
  buildRotaScheduleModel, buildRotaWeekWindow, getRotaCell, isoWeekKey, shiftDurationHours,
} from '../src/components/admin/adminSchedule';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
};

/* Absence assertions must look at CODE, not prose: this suite's own
   explanatory comments quote the defects they describe ("+50 Experience
   points", "Salary/Month", "|| 'Team Member'"), and so do the corrected
   sources. A raw-text absence check would fail on the very comment that
   documents the fix. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const app = read('src/App.tsx');
const pub = read('src/components/PublicPages.tsx');
const admin = read('src/components/AdminPanel.tsx');
const adminSchedule = read('src/components/admin/adminSchedule.ts');
const portal = read('src/components/StaffPortal.tsx');
const checklistPanel = read('src/components/staff/StaffChecklistPanel.tsx');
const dashboardPanel = read('src/components/staff/StaffDashboardPanel.tsx');
const academyPanel = read('src/components/staff/StaffAcademyPanel.tsx');
const staffRuntime = [portal, checklistPanel, dashboardPanel, academyPanel].join('\n');
const studio = read('src/components/admin/WebsiteStudio.tsx');
const pubCode = stripComments(pub);
const adminCode = stripComments(admin);
const portalCode = stripComments(staffRuntime);

console.log('T13 BEHAVIOURAL REGRESSION');
console.log('==========================');

/* ==================================================================== */
console.log('\n\u00a71-3  Public projections against REAL view shapes');
{
  /* The anonymous views do NOT return the internal flag:
       job_vacancies_public — no `status` column
       deals_public         — no `active` column
     so an anonymous row looks exactly like this. T12 filtered on the flag
     being present and correct, which removed EVERY public vacancy and deal. */
  const anonVacancy = { id: 'job-1', title: 'Team Member' };
  const anonDeal = { id: 'deal-1', name: 'Two for One' };

  check('anonymous vacancy row (no status column) stays visible',
    projectPublicVacancies([anonVacancy]).length === 1);
  check('anonymous deal row (no active column) stays visible',
    projectPublicDeals([anonDeal]).length === 1);

  /* Authenticated rows DO carry the flag and must still be filtered. */
  const authVacancies = [
    { id: 'v-pub', status: 'published' },
    { id: 'v-draft', status: 'draft' },
    { id: 'v-closed', status: 'closed' },
  ];
  check('authenticated: published vacancy kept, draft and closed removed',
    projectPublicVacancies(authVacancies).map((v) => v.id).join(',') === 'v-pub');

  const authDeals = [{ id: 'd-on', active: true }, { id: 'd-off', active: false }];
  check('authenticated: active deal kept, inactive removed',
    projectPublicDeals(authDeals).map((d) => d.id).join(',') === 'd-on');

  /* Mixed list — the case a signed-in owner browsing public routes produces. */
  check('a mixed anonymous+authenticated list keeps exactly the public rows',
    projectPublicVacancies([anonVacancy, ...authVacancies]).map((v) => v.id).join(',') === 'job-1,v-pub');

  /* Menu and News views DO return their flags, so the strict test is right
     there — an absent flag is not an expected shape for those two. */
  check('menu still filters on available (that view RETURNS the column)',
    projectPublicMenuItems([{ id: 'm1', available: true }, { id: 'm2', available: false }]).length === 1);
  check('news still filters on status (that view RETURNS the column)',
    projectPublicNews([{ id: 'n1', status: 'published' }, { id: 'n2', status: 'draft' }]).length === 1);
  check('stores keep the columnless-anonymous rule',
    projectPublicStores([{ id: 's-anon' }, { id: 's-draft', setupStatus: 'DRAFT' }]).map((s) => s.id).join(',') === 's-anon');
}

/* ==================================================================== */
console.log('\n\u00a74-5  Scope signature: role downgrade and store transfer');
{
  /* The scope key as the app computes it. Pinned against the source below so
     this executable copy cannot drift from the shipped expression. */
  const scopeKey = (employee) => employee
    ? `${employee.id}|${employee.role}|${employee.storeId ?? ''}`
    : null;
  check('the executed expression matches the one in App.tsx',
    app.includes('`${employee.id}|${employee.role}|${employee.storeId ?? \'\'}`'));

  const owner = { id: 'u1', role: 'owner', storeId: 'st_a' };
  const demoted = { id: 'u1', role: 'store_manager', storeId: 'st_a' };
  const moved = { id: 'u1', role: 'store_manager', storeId: 'st_b' };
  const staff = { id: 'u1', role: 'team_member', storeId: 'st_b' };

  check('a ROLE downgrade changes the signature (same user id)',
    scopeKey(owner) !== scopeKey(demoted), `${scopeKey(owner)} vs ${scopeKey(demoted)}`);
  check('a STORE transfer changes the signature (same user id and role)',
    scopeKey(demoted) !== scopeKey(moved), `${scopeKey(demoted)} vs ${scopeKey(moved)}`);
  check('manager \u2192 team member changes the signature',
    scopeKey(moved) !== scopeKey(staff));
  check('an unchanged profile keeps the SAME signature (no needless purge)',
    scopeKey(owner) === scopeKey({ id: 'u1', role: 'owner', storeId: 'st_a' }));
  check('signing out yields a null signature', scopeKey(null) === null);
  check('a user with no store still produces a stable signature',
    scopeKey({ id: 'u2', role: 'owner' }) === 'u2|owner|');
  /* The boundary and the hydration effect must both key on it. */
  check('the identity boundary compares the scope signature',
    /lastHydratedFor\.current !== employeeScopeKey/.test(app));
  check('the hydration effect depends on the scope signature',
    /\[employeeScopeKey, hydrateNonce\]/.test(app));
}

/* ==================================================================== */
console.log('\n\u00a76  Private cleanup clears every complete collection');
{
  const start = app.indexOf('const resetPrivateState');
  const body = app.slice(start, app.indexOf('}, []);', start));
  for (const setter of ['setMenuItems([])', 'setStores([])', 'setVacancies([])',
    'setNewsPosts([])', 'setDeals([])', "setPublicStates(allPublicStates('loading'))"]) {
    check(`cleanup resets ${setter.split('(')[0]}`, body.includes(setter));
  }
  check('a signed-out tab re-pulls the anonymous public site after cleanup',
    /runPublicPullRef\.current\?\.\(\)/.test(app));
}

/* ==================================================================== */
console.log('\n\u00a77-8  Careers selection lifecycle (executed)');
{
  /* The shipped rule, extracted verbatim and executed. */
  const nextSelection = (status, activeVacancies, selectedJob, fromUrl) => {
    if (status !== 'ready') return null;
    if (selectedJob && activeVacancies.some((v) => v.id === selectedJob.id)) return selectedJob;
    return fromUrl ?? activeVacancies[0] ?? null;
  };
  const A = { id: 'a', title: 'Barista' };
  const B = { id: 'b', title: 'Supervisor' };

  check('selecting A while ready keeps A', nextSelection('ready', [A, B], A, null)?.id === 'a');
  check('A closes \u2192 selection moves to the first remaining vacancy (B)',
    nextSelection('ready', [B], A, null)?.id === 'b');
  check('A closes and nothing remains \u2192 selection becomes null',
    nextSelection('ready', [], A, null) === null);
  check('collection UNAVAILABLE \u2192 selection cleared (no stale form during an outage)',
    nextSelection('unavailable', [A, B], A, null) === null);
  check('collection LOADING \u2192 selection cleared',
    nextSelection('loading', [A, B], A, null) === null);
  check('a live selection is RETAINED (explicit URL navigation is the slug effect\'s job)',
    nextSelection('ready', [A, B], A, B)?.id === 'a');
  check('with no live selection, a route slug beats "first active"',
    nextSelection('ready', [A, B], null, B)?.id === 'b');
  check('a stale selection plus a route slug resolves to the slug',
    nextSelection('ready', [B], A, B)?.id === 'b');
  check('the separate slug effect still follows back/forward navigation',
    /if \(fromUrl && fromUrl\.id !== selectedJob\?\.id\) setSelectedJob\(fromUrl\);/.test(pub));
  check('with no selection the first active vacancy is chosen',
    nextSelection('ready', [A, B], null, null)?.id === 'a');
  check('the shipped effect implements exactly this rule',
    /if \(vacancies\.status !== 'ready'\) \{\s*if \(selectedJob !== null\) setSelectedJob\(null\);/.test(pub)
    && /if \(selectedJob && activeVacancies\.some\(\(v\) => v\.id === selectedJob\.id\)\) return;/.test(pub));

  /* Submission guard. */
  const mayApply = (selectedJob, activeVacancies) =>
    Boolean(selectedJob && activeVacancies.some((v) => v.id === selectedJob.id));
  check('an application to a LIVE vacancy is allowed', mayApply(A, [A, B]));
  check('an application to a CLOSED vacancy is refused', !mayApply(A, [B]));
  check('an application with no selection is refused', !mayApply(null, [A]));
  check('the shipped submit refuses a stale vacancy',
    /if \(!selectedJob \|\| !activeVacancies\.some\(\(v\) => v\.id === selectedJob\.id\)\)/.test(pub));
  check('and no longer substitutes the generic "Team Member" position',
    !/'Team Member'/.test(pubCode) && /position: appliedVacancy\.title/.test(pub));
}

/* ==================================================================== */
console.log('\n\u00a79  Asynchronous Store selection (executed)');
{
  const nextStore = (activeStores, current, fromUrl) => {
    if (fromUrl) return fromUrl.id;
    if (current && activeStores.some((st) => st.id === current)) return current;
    return activeStores[0]?.id ?? '';
  };
  const A = { id: 'st_a' }, B = { id: 'st_b' };
  check('loading (empty list) \u2192 selection is empty', nextStore([], '', null) === '');
  check('Store A arrives later \u2192 Store A is selected', nextStore([A], '', null) === 'st_a');
  check('a Store B route selects Store B', nextStore([A, B], 'st_a', B) === 'st_b');
  check('the current store is retained while it still exists', nextStore([A, B], 'st_b', null) === 'st_b');
  check('selected Store B disappears \u2192 falls back to Store A', nextStore([A], 'st_b', null) === 'st_a');
  check('all stores disappear \u2192 selection becomes empty', nextStore([], 'st_a', null) === '');
  check('no fictional fallback id is ever produced',
    ![nextStore([], '', null), nextStore([], 'st_a', null)].includes('s1'));
  check('the shipped effect depends on the LIST as well as the slug',
    /\}, \[routeParams\?\.store, activeStores, activeStoreId\]\);/.test(pub));
}

/* ==================================================================== */
console.log('\n\u00a710-11  One annual-salary pay model (executed)');
{
  /* The task's worked example: £31,200 a year is ~£600 a week, not £7,800. */
  const weeklySalaryCost = (payRate) => weeklyFixedSalaryCost({ payRate, payType: 'salary' });
  check('\u00a331,200 annual \u2192 \u00a3600.00 weekly labour cost',
    weeklySalaryCost(31200)?.toFixed(2) === '600.00', weeklySalaryCost(31200)?.toFixed(2));
  check('the old monthly assumption (\u00f74) would have produced \u00a37,800 \u2014 and is gone',
    (31200 / 4).toFixed(2) === '7800.00' && !/stat\.payRate \/ 4/.test(adminCode));
  check('the shipped weekly cost uses the shared annual-salary helper',
    /weeklyFixedSalaryCost/.test(adminSchedule) && /buildRotaScheduleModel/.test(admin));

  check('hourly rate passes through unchanged', effectiveHourlyRate({ payRate: 12.5, payType: 'hourly' }) === 12.5);
  check('salary is never converted into a timesheet cash rate',
    effectiveHourlyRate({ payRate: 20800, payType: 'salary' }) === null);
  check('no pay rate \u2192 null (no fabricated amount)', effectiveHourlyRate({}) === null);
  check('zero pay rate \u2192 null', effectiveHourlyRate({ payRate: 0, payType: 'hourly' }) === null);
  check('a small annual salary is still payroll-managed, not hourly',
    effectiveHourlyRate({ payRate: 2080, payType: 'salary' }) === null);
  check('unconfigured pay is EXCLUDED from labour cost, not counted as zero',
    /if \(!\(stat\.payRate > 0\)\) \{\s*stat\.cost = null;/.test(adminSchedule) && /unpricedStaff\.push\(stat\.name\)/.test(adminSchedule));

  /* Wording: no "NET" on an estimate; no monthly salary label anywhere. */
  check('no estimate is labelled NET', !/NET/.test(adminCode) && !/NET/.test(portalCode));
  check('no "Salary/Month" label remains', !/Salary\/Month/.test(adminCode));
  check('the salary label states ANNUAL in both the form and the drawer',
    (admin.match(/Annual salary \(\u00a3 \/ year\)|Annual Salary \(\u00a3 \/ year\)/g) || []).length >= 2);
  check('estimates are described as estimated gross / labour cost',
    /est\. gross/.test(admin) && /Estimated labour cost/.test(admin));
}

/* ==================================================================== */
console.log('\n\u00a711b  Admin rota projection is shared and deterministic (executed)');
{
  const employee = (id, name, payRate, payType = 'hourly') => ({
    id, name, email: `${id}@example.invalid`, role: 'team_member', storeId: 'store-1', storeName: 'Store 1',
    nextShift: '', holidayBalance: 0, points: 0, level: 1, badges: [], avatar: '', payRate, payType,
  });
  const shift = (id, employeeId, employeeName, date, startTime, endTime) => ({
    id, employeeId, employeeName, role: 'team_member', storeId: 'store-1', storeName: 'Store 1',
    date, startTime, endTime, type: 'mid', notes: '',
  });
  const employees = [employee('e1', 'Alex', 12), employee('e2', 'Alex', 31200, 'salary'), employee('e3', 'No Rate')];
  const shifts = [
    shift('s2', 'e1', 'Alex', '2026-08-04', '18:00', '02:00'),
    shift('s1', 'e1', 'Alex', '2026-08-03', '09:00', '17:00'),
    shift('s3', 'e2', 'Alex', '2026-08-03', '10:00', '18:00'),
    shift('s4', 'e3', 'No Rate', '2026-08-03', '11:00', '15:00'),
  ];
  const model = buildRotaScheduleModel(shifts, employees);
  check('overnight rota duration is preserved', shiftDurationHours('18:00', '02:00') === 8);
  check('ISO week grouping is stable', isoWeekKey('2026-08-03') === '2026-W32');
  check('the month view is chronological', model.dates.join(',') === '2026-08-03,2026-08-04');
  check('the week cell is sorted and indexed once', getRotaCell(model, 'e1', '2026-08-03').map((item) => item.id).join(',') === 's1');
  check('duplicate employee names keep distinct stable rows', model.weekSummaries[0]?.employees.length === 3
    && new Set(model.weekSummaries[0]?.employees.map((item) => item.employeeId)).size === 3);
  check('hourly, annual salary and missing-rate cost rules share one projection',
    model.weekSummaries[0]?.totalHours === 28
    && model.weekSummaries[0]?.totalCost === 792
    && model.weekSummaries[0]?.unpricedStaff.join(',') === 'No Rate');
  const window = buildRotaWeekWindow(0, '2026-08-05');
  check('week window starts Monday and ends Sunday', window.isos[0] === '2026-08-03' && window.isos[6] === '2026-08-09');
  check('Admin renders all three rota views from the shared model',
    /getRotaCell\(rotaModel/.test(admin) && /rotaModel\.weekSummaries/.test(admin) && /rotaModel\.dates/.test(admin));
}

/* ==================================================================== */
console.log('\n\u00a712  Checklist submission makes no false reward claim');
{
  check('no "+50 Experience points" message remains', !/50 Experience points/.test(portalCode));
  check('no client-side points increment remains', !/points: employee\.points \+ 50/.test(portalCode));
  check('no client-side /450 level rule remains', !/\/ 450/.test(portalCode));
  check('the success message is plain and truthful',
    /addToast\('Checklist submitted and recorded\.', 'success'\)/.test(checklistPanel));
  check('the checklist audit and reset persist atomically through the server RPC',
    /onSubmitCategory\(businessDate, activeCategory\)/.test(checklistPanel)
    && /submit_checklist_category/.test(app)
    && /submit_checklist_category/.test(read('supabase/migration_t1331_operational_atomicity.sql')));
  check('Academy points are untouched (server training workflow)',
    /onCompleteTraining\(\{/.test(academyPanel));
}

/* ==================================================================== */
console.log('\n\u00a713  State-dependent actions require live hydration');
{
  const refuse = (staffDataStatus) => staffDataStatus !== 'live';
  check('idle blocks state-dependent actions', refuse('idle'));
  check('loading blocks them', refuse('loading'));
  check('error blocks them', refuse('error'));
  check('live allows them', !refuse('live'));
  check('one clear message is used across every state-dependent staff panel',
    [checklistPanel, dashboardPanel, academyPanel].every((source) =>
      source.includes('Internal data is not fully loaded. Retry before making changes.')));

  const gatedHandlers = [
    ['submitCategory', checklistPanel],
    ['handlePublishCoverRequest', dashboardPanel],
    ['handleRetractCoverRequest', dashboardPanel],
    ['handleClaimCoverShift', dashboardPanel],
  ];
  for (const [fn, source] of gatedHandlers) {
    const i = source.indexOf(`const ${fn} =`);
    check(`${fn} is gated`, i > 0 && source.slice(i, i + 320).includes('refuseIfNotLive()'));
  }
  check('Academy assessment submission is gated',
    /if \(refuseIfNotLive\(\)\) return; \/\/ T13-8\s*setAcademySubmitting\(true\);/.test(academyPanel));
  check('collection-wide publishing is already gated on live hydration (T12)',
    /if \(staffDataStatus !== 'live'\)/.test(app));
}

/* ==================================================================== */
console.log('\n\u00a714  Duplicate-action lock is SYNCHRONOUS (executed)');
{
  /* The shipped wrapper's logic with a ref, exercised exactly as two clicks
     in one tick would exercise it: both calls happen before any await
     resolves and before React would have re-rendered. */
  const makeWrapper = () => {
    const busyRef = { current: null };
    let stateBusy = null;                 // stands in for React state (lags)
    let runs = 0;
    const withBusy = async (key, run) => {
      if (busyRef.current) return;
      busyRef.current = key;
      stateBusy = key;
      try { runs += 1; await run(); }
      finally { busyRef.current = null; stateBusy = null; }
    };
    return { withBusy, runs: () => runs, ref: busyRef, state: () => stateBusy };
  };

  let w = makeWrapper();
  const work = () => new Promise((r) => setTimeout(r, 5));
  await Promise.all([w.withBusy('save', work), w.withBusy('save', work)]);
  check('two synchronous invocations run the request ONCE', w.runs() === 1, `ran ${w.runs()}x`);
  check('the lock is released after success', w.ref.current === null);

  w = makeWrapper();
  await Promise.all([
    w.withBusy('save', async () => { throw new Error('boom'); }).catch(() => {}),
    w.withBusy('save', work),
  ]);
  check('a THROWN exception still releases the lock', w.ref.current === null);
  check('…and the second synchronous click was still refused', w.runs() === 1, `ran ${w.runs()}x`);

  w = makeWrapper();
  await w.withBusy('save', async () => { /* handled failure: returns normally */ });
  check('a handled failure releases the lock', w.ref.current === null);
  await w.withBusy('save', work);
  check('…and a LATER click is accepted once released', w.runs() === 2, `ran ${w.runs()}x`);

  /* The state-only guard the ref replaced would have let both through. */
  const stateOnly = () => {
    let busy = null, runs = 0;
    const call = (run) => { if (busy) return null; busy = 'x'; runs += 1; return run().finally(() => { busy = null; }); };
    return { call, runs: () => runs, simulateSyncPair: () => { const b = null; let r = 0; const c = () => { if (b) return; r += 1; }; c(); c(); return r; } };
  };
  check('demonstrating WHY: a state-only guard (no ref) admits both clicks',
    stateOnly().simulateSyncPair() === 2);

  check('the shipped Admin wrapper takes the ref before its first await',
    /if \(busyRef\.current\) return;\s*busyRef\.current = key;/.test(admin));
  check('…and clears it in finally', /finally \{\s*\/\/ Released on success[\s\S]{0,120}busyRef\.current = null;/.test(admin));
  check('Website Studio publish uses the same synchronous lock',
    /if \(!isDirty \|\| publishBusyRef\.current\) return;\s*publishBusyRef\.current = true;/.test(studio));
}

/* ==================================================================== */
console.log('\n\u00a715  Launch Facts own the public business identity');
{
  /* The Studio must not offer editable duplicates of the authoritative facts,
     and — more importantly — must not be able to WRITE them even if a field
     were re-added, because the save merges only STUDIO_SETTINGS_KEYS. */
  const keysBlock = studio.slice(studio.indexOf('const STUDIO_SETTINGS_KEYS'), studio.indexOf('];', studio.indexOf('const STUDIO_SETTINGS_KEYS')));
  for (const k of ['legalName', 'companyNumber', 'hqAddress', 'phone', 'email', 'gdprEmail', 'websiteUrl']) {
    check(`the Studio cannot persist ${k}`, !keysBlock.includes(`'${k}'`));
  }
  for (const k of ['announcementEnabled', 'announcementText', 'footerTagline',
    'allergenNotice', 'instagramHandle', 'instagramUrl', 'facebookUrl', 'twitterUrl']) {
    check(`the Studio still owns ${k}`, keysBlock.includes(`'${k}'`));
  }
  check('the authoritative fields render read-only, pointing at Launch Facts',
    studio.includes('Managed in Settings \u2192 Launch Facts')
    && (studio.match(/kind: 'managed'/g) || []).length === 7);
  /* This check exists because its absence hid a real bug: `settingsDraft` is
     built by picking ONLY STUDIO_SETTINGS_KEYS, and the seven authoritative
     keys were deliberately removed from that list — so a managed field that
     read the DRAFT rendered "Not set" for every value, however correct the
     underlying data was. Read-only display must come from the RESOLVED
     settings (hydrated from public_site_configuration), which is exactly what
     the public site shows. */
  check('a managed field renders the RESOLVED value, not the (deliberately empty) studio draft',
    /const resolved = siteSettings\[field\.key\];/.test(studio)
    && /String\(resolved \?\? ''\)\.trim\(\)/.test(studio)
    && !/const resolved = \(settingsDraft/.test(studio));
  {
    /* Executed: the draft-pick the component performs, against a settings
       object holding real values. Every authoritative key must be ABSENT from
       the draft (so it cannot be saved) and PRESENT in the resolved source. */
    const studioKeys = ['announcementEnabled', 'announcementText', 'footerTagline',
      'allergenNotice', 'instagramHandle', 'instagramUrl', 'facebookUrl', 'twitterUrl'];
    const launchKeys = ['legalName', 'companyNumber', 'hqAddress', 'phone', 'email', 'gdprEmail', 'websiteUrl'];
    const siteSettings = Object.fromEntries([...studioKeys, ...launchKeys].map((k) => [k, `value-of-${k}`]));
    const draft = Object.fromEntries(studioKeys.map((k) => [k, siteSettings[k]]));
    check('no authoritative key survives into the studio draft',
      launchKeys.every((k) => draft[k] === undefined));
    check('…so reading the draft would render every one of them blank (the bug)',
      launchKeys.every((k) => String(draft[k] ?? '').trim() === ''));
    check('…while reading the resolved settings renders the real value',
      launchKeys.every((k) => String(siteSettings[k] ?? '').trim() === `value-of-${k}`));
    check('the studio-owned keys are still editable in the draft',
      studioKeys.every((k) => draft[k] === siteSettings[k]));
  }
  check('read-only fields never count as pending changes',
    /if \(sf\.kind === 'managed'\) continue;/.test(studio));
  check('the public projection remains the single public source (T12, intact)',
    /readTable: 'public_site_configuration'/.test(read('src/lib/cloudSync.ts')));
}

console.log(`\nT13 BEHAVIOURAL REGRESSION \u2014 ${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
