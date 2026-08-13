import React, { useMemo, useState } from 'react';
import type { EmployeeProfile } from '../../types';
import { useSingleFlight } from '../../hooks/useSingleFlight';

interface RecognitionDraft {
  empId: string;
  points: number | '';
  reason: string;
}

interface RecognitionPanelProps {
  employees: EmployeeProfile[];
  onUpdateEmployee: (employee: EmployeeProfile) => Promise<boolean>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  logAction: (module: string, action: string) => void;
}

const EMPTY_RECOGNITION_DRAFT: RecognitionDraft = { empId: '', points: '', reason: '' };

/** Recognition owns its draft and lock, so typing never rerenders the full admin controller. */
export const RecognitionPanel = React.memo(function RecognitionPanel({
  employees,
  onUpdateEmployee,
  addToast,
  logAction,
}: RecognitionPanelProps) {
  const [draft, setDraft] = useState<RecognitionDraft>(EMPTY_RECOGNITION_DRAFT);
  const employeesById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const mutation = useSingleFlight();

  const awardPoints = async (): Promise<void> => mutation.run('recognition:award', async () => {
    if (!draft.empId) {
      addToast('Please pick an employee.', 'error');
      return;
    }
    const candidate = employeesById.get(draft.empId);
    const employee = candidate?.status !== 'disabled' ? candidate : undefined;
    if (!employee) {
      addToast('That employee is unavailable or disabled. Refresh the staff list and choose again.', 'error');
      return;
    }
    const pointsToAward = Number(draft.points);
    if (!Number.isInteger(pointsToAward) || pointsToAward < 1 || pointsToAward > 1000) {
      addToast('Recognition points must be a whole number between 1 and 1,000.', 'error');
      return;
    }
    const reason = draft.reason.trim();
    if (!reason) {
      addToast('Add a clear reason for the recognition award.', 'error');
      return;
    }

    const points = employee.points + pointsToAward;
    const updated: EmployeeProfile = { ...employee, points, level: Math.floor(points / 400) + 1 };
    if (!(await onUpdateEmployee(updated))) return;
    logAction('Recognition Desk', `Awarded ${pointsToAward} points to ${updated.name} reason: "${reason}"`);
    addToast(`Awarded ${pointsToAward} points to "${updated.name}".`, 'success');
    setDraft(EMPTY_RECOGNITION_DRAFT);
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display font-black text-2xl">Staff Recognition &amp; Points Center</h1>
        <p className="text-2xs text-[#2E2A26]/70">Award recognition points to a real employee with a recorded reason. Academy badges remain tied to completed training.</p>
      </div>

      <div className="bg-white p-5 rounded-2xl border space-y-4 text-2xs text-[#2E2A26]">
        <h3 className="font-display font-black uppercase tracking-wider pb-1 border-b">Award Culture Points Form</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="font-bold" htmlFor="recognition-employee">Select Employee *</label>
            <select id="recognition-employee" value={draft.empId} onChange={(event) => setDraft((current) => ({ ...current, empId: event.target.value }))} className="w-full bg-stone-50 border p-2 rounded-lg">
              <option value="">Rostered Staff</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="font-bold" htmlFor="recognition-points">Points *</label>
            <input id="recognition-points" type="number" min="1" max="1000" step="1" value={draft.points} onChange={(event) => setDraft((current) => ({ ...current, points: event.target.value === '' ? '' : Number(event.target.value) }))} className="w-full bg-stone-50 border p-2 rounded-lg" />
          </div>
          <div className="space-y-1">
            <label className="font-bold" htmlFor="recognition-reason">Award reason *</label>
            <input id="recognition-reason" type="text" placeholder="e.g. Exceptional customer care during a busy peak" value={draft.reason} onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))} className="w-full bg-stone-50 border p-2 rounded-lg" />
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={() => { void awardPoints(); }}
            disabled={mutation.isBusy}
            className="px-5 py-2.5 bg-[#A46832] text-white rounded-full font-black uppercase text-2xs cursor-pointer shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.activeKey === 'recognition:award' ? 'Saving…' : 'Award Culture Points'}
          </button>
        </div>
      </div>
    </div>
  );
});
