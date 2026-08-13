/**
 * Pure payroll-period projection for the Admin earnings desk.
 *
 * The UI previously filtered the complete clock-history collection multiple
 * times per employee and repeated the same approval rules during generation
 * and preview. This model performs one period scan and gives both paths the
 * same approved/pending/estimate facts.
 */
import type { ClockHistoryItem, EmployeeProfile, Payslip } from '../../types';
import { effectiveHourlyRate } from '../../lib/pay';

export interface AdminPayrollEmployeePeriod {
  employee: EmployeeProfile;
  approvedHours: number;
  pendingHours: number;
  approvedEntries: ClockHistoryItem[];
  hasExistingEstimate: boolean;
  hourlyRate: number | null;
  isSalary: boolean;
}

export interface AdminPayrollPeriodModel {
  periodKey: string;
  label: string;
  rows: AdminPayrollEmployeePeriod[];
  byEmployeeId: Map<string, AdminPayrollEmployeePeriod>;
}

export function payrollMonthLabel(periodKey: string): string {
  const [year = 0, month = 1] = periodKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });
}

export function previousCalendarMonthKey(now = new Date()): string {
  const date = new Date(now);
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function buildAdminPayrollPeriod(
  employees: EmployeeProfile[],
  clockHistory: ClockHistoryItem[],
  payslips: Payslip[],
  periodKey: string,
): AdminPayrollPeriodModel {
  const existingEstimateIds = new Set(
    payslips.filter((payslip) => payslip.periodKey === periodKey).map((payslip) => payslip.employeeId),
  );
  const byEmployeeId = new Map<string, AdminPayrollEmployeePeriod>();

  for (const employee of employees) {
    byEmployeeId.set(employee.id, {
      employee,
      approvedHours: 0,
      pendingHours: 0,
      approvedEntries: [],
      hasExistingEstimate: existingEstimateIds.has(employee.id),
      hourlyRate: effectiveHourlyRate(employee),
      isSalary: employee.payType === 'salary',
    });
  }

  for (const entry of clockHistory) {
    if (!entry.date.startsWith(periodKey)) continue;
    const row = byEmployeeId.get(entry.employeeId);
    if (!row || entry.rejected) continue;
    const hours = Number.isFinite(entry.totalDecimalHours) ? entry.totalDecimalHours || 0 : 0;
    if (entry.approved) {
      row.approvedHours += hours;
      row.approvedEntries.push(entry);
    } else {
      row.pendingHours += hours;
    }
  }

  for (const row of byEmployeeId.values()) {
    row.approvedEntries.sort((left, right) =>
      left.date.localeCompare(right.date)
      || left.clockIn.localeCompare(right.clockIn)
      || left.id.localeCompare(right.id));
  }

  return {
    periodKey,
    label: payrollMonthLabel(periodKey),
    rows: employees.map((employee) => byEmployeeId.get(employee.id)!),
    byEmployeeId,
  };
}
