/** Pure read models for Admin analytics. */
import type { EmployeeProfile, TrainingAssessment, TrainingCertificate } from '../../types';

export interface AdminTrainingCompletionRow {
  assessmentId: string;
  title: string;
  completedActiveStaff: number;
  activeStaff: number;
  percent: number;
}

/**
 * Course completion must be a people metric, not a certificate-row metric.
 * A reissued/duplicate certificate cannot count one person twice, and disabled
 * profiles do not remain in the active roster denominator.
 */
export function buildAdminTrainingCompletionRows(
  assessments: TrainingAssessment[],
  certificates: TrainingCertificate[],
  employees: EmployeeProfile[],
): AdminTrainingCompletionRow[] {
  const activeEmployeeIds = new Set(
    employees.filter((employee) => employee.status !== 'disabled').map((employee) => employee.id),
  );
  const completedByAssessment = new Map<string, Set<string>>();

  for (const certificate of certificates) {
    if (!activeEmployeeIds.has(certificate.employeeId)) continue;
    const completed = completedByAssessment.get(certificate.assessmentId) || new Set<string>();
    completed.add(certificate.employeeId);
    completedByAssessment.set(certificate.assessmentId, completed);
  }

  const activeStaff = activeEmployeeIds.size;
  return assessments.map((assessment) => {
    const completedActiveStaff = completedByAssessment.get(assessment.id)?.size || 0;
    return {
      assessmentId: assessment.id,
      title: assessment.title,
      completedActiveStaff,
      activeStaff,
      percent: activeStaff === 0 ? 0 : Math.min(100, Math.round((completedActiveStaff / activeStaff) * 100)),
    };
  });
}
