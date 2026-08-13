/**
 * Pure scheduling projections for the Admin rota.
 *
 * The Admin UI has three views of the same shifts (week grid, labour matrix,
 * monthly dispatch). Keeping the grouping and cost rules here ensures those
 * views cannot silently drift and avoids repeatedly filtering the full shift
 * list inside every rendered table cell.
 */
import type { EmployeeProfile, WorkShift } from '../../types';
import { weeklyFixedSalaryCost } from '../../lib/pay';


/** Parse one shift into an overnight-aware half-open interval. */
export function shiftInterval(shift: Pick<WorkShift, 'date' | 'startTime' | 'endTime'>): [number, number] | null {
  const date = String(shift.date || '').trim();
  const start = String(shift.startTime || '').slice(0, 5);
  const end = String(shift.endTime || '').slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start === end) return null;
  const startMs = new Date(`${date}T${start}:00`).getTime();
  let endMs = new Date(`${date}T${end}:00`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;
  return [startMs, endMs];
}

/** Client feedback only; the database trigger remains the concurrency authority. */
export function shiftsOverlap(
  left: Pick<WorkShift, 'date' | 'startTime' | 'endTime'>,
  right: Pick<WorkShift, 'date' | 'startTime' | 'endTime'>,
): boolean {
  const leftInterval = shiftInterval(left);
  const rightInterval = shiftInterval(right);
  return !!leftInterval && !!rightInterval
    && leftInterval[0] < rightInterval[1]
    && rightInterval[0] < leftInterval[1];
}

export interface RotaEmployeeWeekStat {
  employeeId: string;
  name: string;
  hours: number;
  cost: number | null;
  payRate: number;
  payType: 'hourly' | 'salary';
  shifts: WorkShift[];
}

export interface RotaWeekSummary {
  key: string;
  shifts: WorkShift[];
  employees: RotaEmployeeWeekStat[];
  totalHours: number;
  totalCost: number;
  unpricedStaff: string[];
}

export interface RotaScheduleModel {
  shiftsByDate: Map<string, WorkShift[]>;
  shiftsByEmployeeDate: Map<string, WorkShift[]>;
  weekSummaries: RotaWeekSummary[];
  dates: string[];
}

export interface RotaWeekWindow {
  days: Array<{ date: Date; iso: string }>;
  isos: string[];
  todayIso: string;
}

const employeeDateKey = (employeeId: string, date: string): string => `${employeeId}\u0000${date}`;

/** Same overnight-aware duration rule used by the pre-submit overlap guard. */
export function shiftDurationHours(start: string, end: string): number {
  const [startHour = 0, startMinute = 0] = start.split(':').map(Number);
  const [endHour = 0, endMinute = 0] = end.split(':').map(Number);
  let minutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  if (minutes < 0) minutes += 24 * 60;
  return minutes / 60;
}

/** ISO week key, retained exactly from the previous Admin matrix algorithm. */
export function isoWeekKey(dateString: string): string {
  const date = new Date(dateString);
  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${weekNumber.toString().padStart(2, '0')}`;
}

export function buildRotaWeekWindow(weekOffset: number, todayIso: string): RotaWeekWindow {
  const [year = 0, month = 1, day = 1] = todayIso.split('-').map(Number);
  const base = new Date(year, month - 1, day);
  const dayIndex = (base.getDay() + 6) % 7; // Mon=0 … Sun=6
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() - dayIndex + weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(base);
    date.setDate(base.getDate() + index);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { date, iso };
  });
  return { days, isos: days.map((item) => item.iso), todayIso };
}

export function getRotaCell(model: RotaScheduleModel, employeeId: string, date: string): WorkShift[] {
  return model.shiftsByEmployeeDate.get(employeeDateKey(employeeId, date)) || [];
}

export function buildRotaScheduleModel(shifts: WorkShift[], employees: EmployeeProfile[]): RotaScheduleModel {
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const shiftsByDate = new Map<string, WorkShift[]>();
  const shiftsByEmployeeDate = new Map<string, WorkShift[]>();
  const shiftsByWeek = new Map<string, WorkShift[]>();

  for (const shift of shifts) {
    const dateList = shiftsByDate.get(shift.date) || [];
    dateList.push(shift);
    shiftsByDate.set(shift.date, dateList);

    const cellKey = employeeDateKey(shift.employeeId, shift.date);
    const cellList = shiftsByEmployeeDate.get(cellKey) || [];
    cellList.push(shift);
    shiftsByEmployeeDate.set(cellKey, cellList);

    const weekKey = isoWeekKey(shift.date);
    const weekList = shiftsByWeek.get(weekKey) || [];
    weekList.push(shift);
    shiftsByWeek.set(weekKey, weekList);
  }

  const chronological = (left: WorkShift, right: WorkShift): number =>
    left.date.localeCompare(right.date) || left.startTime.localeCompare(right.startTime) || left.id.localeCompare(right.id);
  for (const list of shiftsByDate.values()) list.sort(chronological);
  for (const list of shiftsByEmployeeDate.values()) list.sort(chronological);
  for (const list of shiftsByWeek.values()) list.sort(chronological);

  const weekSummaries = [...shiftsByWeek.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, weekShifts]): RotaWeekSummary => {
      const statsByEmployee = new Map<string, RotaEmployeeWeekStat>();
      for (const shift of weekShifts) {
        const employee = employeesById.get(shift.employeeId);
        let stat = statsByEmployee.get(shift.employeeId);
        if (!stat) {
          stat = {
            employeeId: shift.employeeId,
            name: shift.employeeName,
            hours: 0,
            cost: 0,
            payRate: employee?.payRate || 0,
            payType: employee?.payType || 'hourly',
            shifts: [],
          };
          statsByEmployee.set(shift.employeeId, stat);
        }
        stat.hours += shiftDurationHours(shift.startTime, shift.endTime);
        stat.shifts.push(shift);
      }

      let totalHours = 0;
      let totalCost = 0;
      const unpricedStaff: string[] = [];
      const employeeStats = [...statsByEmployee.values()];
      for (const stat of employeeStats) {
        totalHours += stat.hours;
        if (!(stat.payRate > 0)) {
          stat.cost = null;
          unpricedStaff.push(stat.name);
          continue;
        }
        stat.cost = stat.payType === 'salary'
          ? weeklyFixedSalaryCost({ payRate: stat.payRate, payType: stat.payType })
          : stat.hours * stat.payRate;
        if (stat.cost !== null) totalCost += stat.cost;
      }
      employeeStats.sort((left, right) => right.hours - left.hours || left.name.localeCompare(right.name));
      return { key, shifts: weekShifts, employees: employeeStats, totalHours, totalCost, unpricedStaff };
    });

  return {
    shiftsByDate,
    shiftsByEmployeeDate,
    weekSummaries,
    dates: [...shiftsByDate.keys()].sort(),
  };
}
