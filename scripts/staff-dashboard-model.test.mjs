#!/usr/bin/env node
/** Runtime contract for the pure employee dashboard projections. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import nodeModule from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const strip = typeof nodeModule.stripTypeScriptTypes === 'function'
  ? nodeModule.stripTypeScriptTypes.bind(nodeModule)
  : null;
let ts = null;
try { ts = (await import('typescript')).default; } catch { /* source gate runs before npm install */ }
let passed = 0;
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  ok ? passed++ : failed++;
};

function compile(relative) {
  const source = read(relative);
  if (ts) return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  }).outputText;
  if (!strip) throw new Error('TypeScript runtime unavailable');
  const exported = [];
  let output = strip(source, { mode: 'transform' })
    .replace(/^import\s+\{([\s\S]*?)\}\s+from ['"]([^'"]+)['"];?$/gm,
      (_match, names, specifier) => `const {${names}} = require(${JSON.stringify(specifier)});`)
    .replace(/^export function (\w+)\s*\(/gm, (_match, name) => {
      exported.push(name);
      return `function ${name}(`;
    });
  output += `\nmodule.exports = { ${exported.join(', ')} };\n`;
  return output;
}

function execute(relative, requireMap = {}) {
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    console,
    Intl,
    Date,
    Map,
    Set,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected import ${specifier}`);
    },
  });
  new vm.Script(compile(relative), { filename: relative }).runInContext(context);
  return module.exports;
}

try {
  const businessDate = execute('src/lib/businessDate.ts');
  const pay = execute('src/lib/pay.ts', { '../types': {} });
  const model = execute('src/components/staff/staffDashboardModel.ts', {
    '../../types': {},
    '../../lib/businessDate': businessDate,
    '../../lib/pay': pay,
    '../../lib/storeState': {},
  });
  const dashboardSource = read('src/components/staff/StaffDashboardPanel.tsx');

  const employee = {
    id: 'e1', name: 'Alex', email: 'alex@example.invalid', role: 'team_member',
    storeId: 'store-1', storeName: 'Store 1', nextShift: '', holidayBalance: 0,
    points: 0, level: 1, badges: [], avatar: '', payRate: 12, payType: 'hourly',
  };
  const shift = (id, employeeId, storeId, date, startTime, endTime, employeeName = 'Alex') => ({
    id, employeeId, employeeName, role: 'team_member', storeId, storeName: storeId,
    date, startTime, endTime, type: 'mid', notes: '',
  });
  const shifts = [
    shift('mine-1', 'e1', 'store-1', '2026-08-03', '09:00', '17:00'),
    shift('mine-2', 'e1', 'store-1', '2026-08-05', '20:30', '02:00'),
    shift('team-1', 'e2', 'store-1', '2026-08-04', '10:00', '18:00', 'Sam'),
    shift('other-store', 'e3', 'store-2', '2026-08-04', '10:00', '18:00', 'Pat'),
    shift('past-cover', 'e4', 'store-1', '2026-08-02', '10:00', '18:00', 'Jo'),
  ];
  const covers = {
    'team-1': { employeeId: 'e2', employeeName: 'Sam', message: 'Study commitment', date: '2026-08-03T10:00:00Z' },
    'other-store': { employeeId: 'e3', employeeName: 'Pat', message: 'Other store', date: '2026-08-03T10:00:00Z' },
    'past-cover': { employeeId: 'e4', employeeName: 'Jo', message: 'Expired', date: '2026-08-01T10:00:00Z' },
    orphan: { employeeId: 'e9', employeeName: 'Gone', message: 'Deleted shift', date: '2026-08-03T10:00:00Z' },
  };

  const all = model.buildStaffRotaModel({
    shifts, covers, employeeId: 'e1', storeId: 'store-1', selectedDate: 'all', todayIso: '2026-08-03',
  });
  const emptyDay = model.buildStaffRotaModel({
    shifts, covers, employeeId: 'e1', storeId: 'store-1', selectedDate: '2026-08-06', todayIso: '2026-08-03',
  });

  check('28-day selector starts on the store week Monday',
    all.cycleDays.length === 28 && all.cycleDays[0]?.dateCode === '2026-08-03' && all.cycleDays[27]?.dateCode === '2026-08-30');
  check('selected empty day remains distinguishable from an entirely empty rota',
    all.myShifts.length === 2 && emptyDay.visibleMyShifts.length === 0 && emptyDay.myShifts.length === 2);
  check('team projection is store-scoped and grouped once by visible date',
    all.teamShifts.map((item) => item.id).join(',') === 'past-cover,team-1'
    && all.teamDates.join(',') === '2026-08-02,2026-08-04'
    && all.teamShiftsByDate.get('2026-08-04')?.[0]?.id === 'team-1');
  check('open-cover projection removes orphan, cross-store and expired records',
    all.openCoverShifts.map((item) => item.id).join(',') === 'team-1');
  const late = model.getShiftTimelinePosition('20:30', '02:00');
  const early = model.getShiftTimelinePosition('05:00', '09:00');
  check('timeline clips overnight and early shifts inside the visible 07:00–22:00 range',
    late.left === '90%' && late.width === '10%'
    && early.left === '0%' && Number.parseFloat(early.width) > 13 && Number.parseFloat(early.width) < 14);
  check('date-only formatting is timezone-stable',
    model.formatDateOnly('2026-08-03', { weekday: 'long', day: 'numeric', month: 'long' }) === 'Monday 3 August');

  const earnings = model.buildStaffEarningsModel({
    employee,
    clockHistory: [
      { id: 'c1', employeeId: 'e1', employeeName: 'Alex', storeId: 'store-1', storeName: 'Store 1', date: '2026-09-01', clockIn: '', clockOut: '', totalDecimalHours: 5, approved: false, rejected: false },
      { id: 'c2', employeeId: 'e1', employeeName: 'Alex', storeId: 'store-1', storeName: 'Store 1', date: '2026-08-20', clockIn: '', clockOut: '', totalDecimalHours: 8, approved: true, rejected: false },
      { id: 'c3', employeeId: 'e1', employeeName: 'Alex', storeId: 'store-1', storeName: 'Store 1', date: '2026-09-02', clockIn: '', clockOut: '', totalDecimalHours: 9, approved: true, rejected: true },
    ],
    payslips: [],
    now: '2026-08-31T23:30:00Z',
    timezone: 'Europe/London',
  });
  check('earnings month follows store time at the BST boundary',
    earnings.currentMonthKey === '2026-09' && earnings.previousMonthKey === '2026-08'
    && earnings.currentMonthHours === 5 && earnings.previousApprovedHours === 8
    && earnings.previousGross === 96);
  const salary = model.buildStaffEarningsModel({
    employee: { ...employee, payType: 'salary', payRate: 31_200 },
    clockHistory: [], payslips: [], now: '2026-08-03T12:00:00Z', timezone: 'Europe/London',
  });
  check('salary dashboard never infers pay from clocked hours', salary.hourlyRate === null && salary.previousGross === null);
  check('dashboard consumes the shared projections instead of repeated JSX scans',
    /buildStaffRotaModel/.test(dashboardSource) && /buildStaffEarningsModel/.test(dashboardSource)
    && !/shiftsList\.filter/.test(dashboardSource) && !/clockHistory\.filter/.test(dashboardSource)
    && !/payslips\.filter/.test(dashboardSource));
} catch (error) {
  console.error(error);
  failed += 1;
}

console.log(`\nSTAFF DASHBOARD MODEL — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
