/**
 * Pure read models for the employee dashboard.
 *
 * The dashboard has several views of the same rota, cover, timesheet and
 * earnings data. Centralising those projections avoids repeated full-array
 * scans inside JSX and keeps empty-state and store-date rules consistent.
 * All mutations remain server-authoritative in StaffDashboardPanel.
 */
import type { ClockHistoryItem, EmployeeProfile, Payslip, WorkShift } from '../../types';
import { businessDateISOAt } from '../../lib/businessDate';
import { effectiveHourlyRate } from '../../lib/pay';
import type { ShiftCoverBoard } from '../../lib/storeState';

export type StaffRotaFilter = 'all' | string;

export interface StaffRotaDay {
  dateCode: string;
  code: string;
  num: string;
  hasShift: boolean;
}

export interface StaffRotaModel {
  cycleDays: StaffRotaDay[];
  myShifts: WorkShift[];
  visibleMyShifts: WorkShift[];
  teamShifts: WorkShift[];
  visibleTeamShifts: WorkShift[];
  teamDates: string[];
  teamShiftsByDate: Map<string, WorkShift[]>;
  openCoverShifts: WorkShift[];
}

export interface StaffEarningsModel {
  hourlyRate: number | null;
  isSalary: boolean;
  timesheets: ClockHistoryItem[];
  employeePayslips: Payslip[];
  currentMonthKey: string;
  previousMonthKey: string;
  previousMonthLabel: string;
  currentMonthHours: number;
  previousApprovedHours: number;
  previousEstimate: Payslip | undefined;
  previousGross: number | null;
}

const chronologicalShift = (left: WorkShift, right: WorkShift): number =>
  left.date.localeCompare(right.date)
  || left.startTime.localeCompare(right.startTime)
  || left.id.localeCompare(right.id);

function parseIsoDate(dateCode: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateCode)) return null;
  const date = new Date(`${dateCode}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isoFromUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function addIsoDays(dateCode: string, days: number): string {
  const date = parseIsoDate(dateCode);
  if (!date) return dateCode;
  date.setUTCDate(date.getUTCDate() + days);
  return isoFromUtcDate(date);
}

export function formatDateOnly(
  dateCode: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = parseIsoDate(dateCode);
  if (!date) return dateCode;
  return date.toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
}

export function buildRotaCycleDays(todayIso: string, myShiftDates: ReadonlySet<string>): StaffRotaDay[] {
  const today = parseIsoDate(todayIso);
  if (!today) return [];
  const mondayOffset = (today.getUTCDay() + 6) % 7; // Monday=0 … Sunday=6
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - mondayOffset);

  return Array.from({ length: 28 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);
    const dateCode = isoFromUtcDate(date);
    return {
      dateCode,
      code: date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      num: String(date.getUTCDate()),
      hasShift: myShiftDates.has(dateCode),
    };
  });
}

export function buildStaffRotaModel(args: {
  shifts: WorkShift[];
  covers: ShiftCoverBoard;
  employeeId: string;
  storeId: string;
  selectedDate: StaffRotaFilter;
  todayIso: string;
}): StaffRotaModel {
  const { shifts, covers, employeeId, storeId, selectedDate, todayIso } = args;
  const myShifts: WorkShift[] = [];
  const teamShifts: WorkShift[] = [];
  const openCoverShifts: WorkShift[] = [];

  for (const shift of shifts) {
    if (shift.storeId !== storeId) continue;
    if (shift.employeeId === employeeId) myShifts.push(shift);
    else teamShifts.push(shift);
    if (covers[shift.id] && shift.date >= todayIso) openCoverShifts.push(shift);
  }

  myShifts.sort(chronologicalShift);
  teamShifts.sort(chronologicalShift);
  openCoverShifts.sort(chronologicalShift);

  const visibleMyShifts = selectedDate === 'all'
    ? myShifts
    : myShifts.filter((shift) => shift.date === selectedDate);
  const visibleTeamShifts = selectedDate === 'all'
    ? teamShifts
    : teamShifts.filter((shift) => shift.date === selectedDate);

  const teamShiftsByDate = new Map<string, WorkShift[]>();
  for (const shift of visibleTeamShifts) {
    const day = teamShiftsByDate.get(shift.date) || [];
    day.push(shift);
    teamShiftsByDate.set(shift.date, day);
  }

  return {
    cycleDays: buildRotaCycleDays(todayIso, new Set(myShifts.map((shift) => shift.date))),
    myShifts,
    visibleMyShifts,
    teamShifts,
    visibleTeamShifts,
    teamDates: [...teamShiftsByDate.keys()].sort(),
    teamShiftsByDate,
    openCoverShifts,
  };
}

export function getShiftTimelinePosition(
  startTime: string,
  endTime: string,
  dayStartHour = 7,
  dayEndHour = 22,
): { left: string; width: string } {
  const parseMinutes = (value: string): number | null => {
    if (!/^\d{2}:\d{2}$/.test(value)) return null;
    const [hour = 0, minute = 0] = value.split(':').map(Number);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  };

  const start = parseMinutes(startTime);
  let end = parseMinutes(endTime);
  const dayStart = dayStartHour * 60;
  const dayEnd = dayEndHour * 60;
  const total = Math.max(1, dayEnd - dayStart);
  if (start === null || end === null) return { left: '0%', width: '0%' };
  if (end <= start) end += 24 * 60;

  const visibleStart = Math.min(dayEnd, Math.max(dayStart, start));
  const visibleEnd = Math.min(dayEnd, Math.max(dayStart, end));
  const leftPercent = ((visibleStart - dayStart) / total) * 100;
  const availablePercent = Math.max(0, 100 - leftPercent);
  const widthPercent = Math.min(
    availablePercent,
    Math.max(0, ((visibleEnd - visibleStart) / total) * 100),
  );

  return { left: `${leftPercent}%`, width: `${widthPercent}%` };
}

function previousMonth(monthKey: string): { key: string; label: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return { key: '', label: '' };
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const date = new Date(Date.UTC(year, monthIndex - 1, 1, 12));
  return {
    key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
    label: date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

export function buildStaffEarningsModel(args: {
  employee: EmployeeProfile;
  clockHistory: ClockHistoryItem[];
  payslips: Payslip[];
  now: Date | string | number;
  timezone?: string | null;
}): StaffEarningsModel {
  const { employee, clockHistory, payslips, now, timezone } = args;
  const currentMonthKey = businessDateISOAt(now, timezone).slice(0, 7);
  const previous = previousMonth(currentMonthKey);
  const timesheets = clockHistory.filter((log) => log.employeeId === employee.id);
  const acceptedTimesheets = timesheets.filter((log) => !log.rejected);
  const employeePayslips = payslips
    .filter((payslip) => payslip.employeeId === employee.id)
    .sort((left, right) => right.periodKey.localeCompare(left.periodKey) || right.id.localeCompare(left.id));
  const currentMonthHours = acceptedTimesheets
    .filter((log) => log.date.startsWith(currentMonthKey))
    .reduce((total, log) => total + (log.totalDecimalHours || 0), 0);
  const previousApprovedHours = acceptedTimesheets
    .filter((log) => log.date.startsWith(previous.key) && log.approved)
    .reduce((total, log) => total + (log.totalDecimalHours || 0), 0);
  const isSalary = employee.payType === 'salary';
  const hourlyRate = isSalary ? null : effectiveHourlyRate(employee);
  const previousEstimate = employeePayslips.find((payslip) => payslip.periodKey === previous.key);
  const previousGross = isSalary
    ? null
    : previousEstimate?.gross ?? (hourlyRate === null ? null : previousApprovedHours * hourlyRate);

  return {
    hourlyRate,
    isSalary,
    timesheets,
    employeePayslips,
    currentMonthKey,
    previousMonthKey: previous.key,
    previousMonthLabel: previous.label,
    currentMonthHours,
    previousApprovedHours,
    previousEstimate,
    previousGross,
  };
}
