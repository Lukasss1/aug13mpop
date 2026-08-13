/**
 * Honest pay helpers for the small-business portal.
 *
 * - hourly: payRate is a gross hourly rate and may be used for a timesheet
 *   earnings estimate;
 * - salary: payRate is an annual gross salary. Timesheet hours are operational
 *   evidence, not a payroll calculator, so no hourly cash estimate is derived;
 * - missing/non-positive values produce no money estimate.
 */
import type { EmployeeProfile } from '../types';

export function effectiveHourlyRate(emp: Pick<EmployeeProfile, 'payRate' | 'payType'>): number | null {
  if (emp.payType === 'salary') return null;
  if (typeof emp.payRate !== 'number' || !(emp.payRate > 0)) return null;
  return emp.payRate;
}

export function weeklyFixedSalaryCost(emp: Pick<EmployeeProfile, 'payRate' | 'payType'>): number | null {
  if (emp.payType !== 'salary' || typeof emp.payRate !== 'number' || !(emp.payRate > 0)) return null;
  return emp.payRate / 52;
}
