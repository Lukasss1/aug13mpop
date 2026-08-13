import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle, ListChecks } from 'lucide-react';
import type { ChecklistTemplateItem } from '../../types';
import {
  readChecklistState,
  type ChecklistAuditLog,
  type ChecklistItem,
  type StoreChecklistState,
} from '../../lib/checklistState';
import { storeStateKey } from '../../lib/storeState';
import { useSingleFlight } from '../../hooks/useSingleFlight';

type ChecklistCategory = 'opening' | 'midday' | 'closing';

interface StaffChecklistPanelProps {
  storeId?: string;
  businessDate: string;
  templates: ChecklistTemplateItem[];
  appState: Record<string, unknown>;
  staffDataStatus: 'idle' | 'loading' | 'live' | 'error';
  onUpdateTask: (
    businessDate: string,
    taskId: string,
    patch: { completed?: boolean; comment?: string; clearComment?: boolean },
  ) => Promise<StoreChecklistState | null>;
  onSubmitCategory: (
    businessDate: string,
    category: ChecklistCategory,
  ) => Promise<{ state: StoreChecklistState; audits: ChecklistAuditLog[] } | null>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
}

const CATEGORIES: Array<{ key: ChecklistCategory; label: string; color: string }> = [
  { key: 'opening', label: 'Opening Checks', color: 'text-[#A46832]' },
  { key: 'midday', label: 'Mid-day Audits', color: 'text-indigo-600' },
  { key: 'closing', label: 'Closing Routine', color: 'text-stone-700' },
];

const STALE_STATE_MESSAGE = 'Internal data is not fully loaded. Retry before making changes.';

const StaffChecklistPanel: React.FC<StaffChecklistPanelProps> = ({
  storeId,
  businessDate,
  templates,
  appState,
  staffDataStatus,
  onUpdateTask,
  onSubmitCategory,
  addToast,
}) => {
  const checklistFlight = useSingleFlight();
  const [tasks, setTasks] = useState<ChecklistItem[]>([]);
  const [audits, setAudits] = useState<ChecklistAuditLog[]>([]);
  const [activeCategory, setActiveCategory] = useState<ChecklistCategory>('opening');
  const [commentTaskId, setCommentTaskId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');

  const tasksKey = storeStateKey('milkpop_checklist_tasks', storeId);
  const auditsKey = storeStateKey('milkpop_checklist_audits', storeId);
  const actionsDisabled = staffDataStatus !== 'live';

  useEffect(() => {
    if (!tasksKey || !auditsKey) {
      setTasks([]);
      setAudits([]);
      return;
    }

    const storedAudits = appState[auditsKey];
    setAudits(Array.isArray(storedAudits) ? storedAudits as ChecklistAuditLog[] : []);
    setTasks(readChecklistState(appState[tasksKey], businessDate, templates));
  }, [appState, auditsKey, businessDate, tasksKey, templates]);

  const tasksByCategory = useMemo(() => {
    const result: Record<ChecklistCategory, ChecklistItem[]> = { opening: [], midday: [], closing: [] };
    for (const task of tasks) result[task.category].push(task);
    return result;
  }, [tasks]);

  const completion = useMemo(() => {
    const result: Record<ChecklistCategory, { completed: number; total: number }> = {
      opening: { completed: 0, total: 0 },
      midday: { completed: 0, total: 0 },
      closing: { completed: 0, total: 0 },
    };
    for (const category of CATEGORIES) {
      const categoryTasks = tasksByCategory[category.key];
      result[category.key] = {
        completed: categoryTasks.filter((task) => task.completed).length,
        total: categoryTasks.length,
      };
    }
    return result;
  }, [tasksByCategory]);

  const activeTasks = tasksByCategory[activeCategory];
  const activeCompletion = completion[activeCategory];
  const progress = activeCompletion.total > 0
    ? Math.round((activeCompletion.completed / activeCompletion.total) * 100)
    : 0;
  const allDone = activeCompletion.total > 0 && activeCompletion.completed === activeCompletion.total;

  const refuseIfNotLive = (): boolean => {
    if (!actionsDisabled) return false;
    addToast(STALE_STATE_MESSAGE, 'error');
    return true;
  };

  const toggleTask = (taskId: string): void => {
    if (refuseIfNotLive()) return;
    if (!tasksKey) {
      addToast('A store assignment is required before using checklists.', 'error');
      return;
    }
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;

    void checklistFlight.run(`task:${taskId}`, async () => {
      const state = await onUpdateTask(businessDate, taskId, { completed: !task.completed });
      if (!state) {
        addToast('The server did not confirm the task update. Reload the checklist before retrying.', 'error');
        return;
      }
      setTasks(state.tasks);
      addToast('Task status updated! 🥛', 'success');
    });
  };

  const saveComment = (taskId: string): void => {
    if (refuseIfNotLive()) return;
    if (!tasksKey) {
      addToast('A store assignment is required before using checklists.', 'error');
      return;
    }

    void checklistFlight.run(`comment:${taskId}`, async () => {
      const state = await onUpdateTask(businessDate, taskId, { comment: commentText });
      if (!state) {
        addToast('The server did not confirm the observation. Reload the checklist before retrying.', 'error');
        return;
      }
      setTasks(state.tasks);
      setCommentTaskId(null);
      setCommentText('');
      addToast('Observation logged.', 'success');
    });
  };

  const clearComment = (taskId: string): void => {
    if (refuseIfNotLive()) return;
    if (!tasksKey) {
      addToast('A store assignment is required before using checklists.', 'error');
      return;
    }

    void checklistFlight.run(`clear-comment:${taskId}`, async () => {
      const state = await onUpdateTask(businessDate, taskId, { clearComment: true });
      if (!state) {
        addToast('The server did not confirm removal. Reload the checklist before retrying.', 'error');
        return;
      }
      setTasks(state.tasks);
      addToast('Observation removed.', 'warning');
    });
  };

  const submitCategory = (): void => {
    if (refuseIfNotLive()) return;
    if (!tasksKey || !auditsKey) {
      addToast('A store assignment is required before submitting checklists.', 'error');
      return;
    }
    if (activeTasks.length === 0) return;
    if (activeTasks.some((task) => !task.completed)) {
      addToast('Complete every configured check in this section before submitting it.', 'error');
      return;
    }

    void checklistFlight.run(`submit:${activeCategory}`, async () => {
      const result = await onSubmitCategory(businessDate, activeCategory);
      if (!result) {
        addToast('The server did not confirm submission. Reload the checklist before retrying.', 'error');
        return;
      }
      setAudits(result.audits);
      setTasks(result.state.tasks);
      addToast('Checklist submitted and recorded.', 'success');
    });
  };

  return (
    <div className="space-y-8 text-left font-sans animate-fade-in">
      <div className="bg-white p-6 rounded-3xl border border-[#EBDECE] flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div>
          <h2 className="font-display text-sm uppercase font-extrabold tracking-wider text-[#A46832]">Store Operations Shift Checklists</h2>
          <p className="text-2xs text-gray-400 mt-1">Complete the procedures configured for this store. Observations and submitted audits are saved to the shared operations record.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-2xs font-extrabold uppercase tracking-widest shrink-0">
          <span className="px-4 py-2 rounded-xl bg-orange-50 text-[#A46832] border border-orange-100">{completion.opening.completed} / {completion.opening.total} Op Checks</span>
          <span className="px-4 py-2 rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-100">{completion.midday.completed} / {completion.midday.total} Mid Checks</span>
          <span className="px-4 py-2 rounded-xl bg-stone-50 text-stone-600 border border-stone-200">{completion.closing.completed} / {completion.closing.total} Cl Checks</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-8 bg-white p-6 sm:p-8 rounded-3xl border border-[#EBDECE]/70 shadow-sm space-y-6">
          <div className="grid grid-cols-3 gap-2 p-1 bg-[#FFFFFF] rounded-xl border border-neutral-200">
            {CATEGORIES.map((category) => (
              <button
                type="button"
                id={`check-tab-${category.key}`}
                key={category.key}
                onClick={() => setActiveCategory(category.key)}
                className={`py-3 text-center rounded-lg text-2xs uppercase tracking-wider font-extrabold transition-all cursor-pointer ${
                  activeCategory === category.key
                    ? 'bg-white text-[#2E2A26] shadow-xs ring-1 ring-neutral-200'
                    : 'text-neutral-500 hover:text-neutral-800'
                }`}
              >
                <span className={category.color}>{category.label}</span>
              </button>
            ))}
          </div>

          <div className="space-y-3 pt-2">
            {activeTasks.length === 0 ? (
              <div className="p-6 text-center border border-dashed border-[#EBDECE] rounded-2xl bg-[#F7EFE6]/30">
                <p className="text-2xs font-bold text-[#2E2A26]">No checklist has been configured for this store.</p>
                <p className="text-3xs text-neutral-500 mt-1">Ask a manager before starting the checklist process.</p>
              </div>
            ) : activeTasks.map((task) => (
              <div key={task.id} className="p-4 bg-[#FBFBFC] rounded-2xl border border-neutral-200/80 transition-all hover:bg-[#FBFBFC]/90 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggleTask(task.id)}
                    disabled={actionsDisabled || checklistFlight.isBusy}
                    title={actionsDisabled ? STALE_STATE_MESSAGE : undefined}
                    className="flex items-start space-x-3 text-left focus:outline-none cursor-pointer flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="shrink-0 mt-0.5">
                      {task.completed ? <CheckCircle className="h-5 w-5 text-[#5FA777]" /> : <div className="h-5 w-5 rounded-full border border-neutral-300 hover:border-[#A46832] transition-colors" />}
                    </div>
                    <div>
                      <span className={`text-xs font-semibold leading-relaxed ${task.completed ? 'text-neutral-400 line-through' : 'text-[#2E2A26]'}`}>{task.task}</span>
                      {task.completed && (
                        <span className="block text-[9px] uppercase tracking-wider font-extrabold text-[#5FA777] mt-1 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100 inline-block">
                          ✓ Approved by {task.completedBy} at {task.completedAt}
                        </span>
                      )}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => { setCommentTaskId(task.id); setCommentText(task.comment || ''); }}
                    disabled={actionsDisabled || checklistFlight.isBusy}
                    title={actionsDisabled ? STALE_STATE_MESSAGE : undefined}
                    className="text-2xs text-[#A46832] font-extrabold hover:underline whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {task.comment ? 'Edit Note' : 'Add Observation'}
                  </button>
                </div>

                {task.comment && (
                  <div className="bg-amber-50/50 border border-amber-100/70 p-3 rounded-xl text-3xs text-neutral-600 leading-normal font-light flex justify-between items-center ml-8">
                    <p><span className="font-extrabold uppercase text-amber-700 font-sans">Barista Log Note:</span> {task.comment}</p>
                    <button
                      type="button"
                      onClick={() => clearComment(task.id)}
                      disabled={actionsDisabled || checklistFlight.isBusy}
                      title={actionsDisabled ? STALE_STATE_MESSAGE : undefined}
                      className="text-[9px] text-[#2E2A26] hover:text-amber-700 font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Clear
                    </button>
                  </div>
                )}

                {commentTaskId === task.id && (
                  <div className="ml-8 p-3 bg-white border border-neutral-200 rounded-xl space-y-2 animate-fade-in relative z-20">
                    <textarea
                      aria-label={`Observation for ${task.task}`}
                      rows={2}
                      value={commentText}
                      onChange={(event) => setCommentText(event.target.value)}
                      disabled={actionsDisabled || checklistFlight.isBusy}
                      placeholder="Record a factual observation, measurement, shortage or action taken..."
                      className="w-full text-2xs p-2 text-neutral-800 border border-[#EBDECE] rounded-lg focus:outline-none focus:ring-1 focus:ring-[#A46832] font-medium"
                    />
                    <div className="flex justify-end space-x-2">
                      <button type="button" onClick={() => setCommentTaskId(null)} className="px-3 py-1 bg-stone-100 text-stone-600 rounded-md text-3xs font-extrabold uppercase">Cancel</button>
                      <button
                        type="button"
                        onClick={() => saveComment(task.id)}
                        disabled={actionsDisabled || checklistFlight.isBusy}
                        title={actionsDisabled ? STALE_STATE_MESSAGE : undefined}
                        className="px-3 py-1 bg-[#2E2A26] text-white rounded-md text-3xs font-extrabold uppercase border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Log Note
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="space-y-4 pt-4 border-t border-neutral-100">
            <div className="space-y-1 bg-stone-50/50 p-4 rounded-2xl border border-stone-200">
              <div className="flex items-center justify-between text-2xs font-black">
                <span className="text-gray-400 uppercase tracking-widest font-sans font-extrabold">Active Compliance Level</span>
                <span className="text-[#A46832] font-mono">{progress}% Done ({activeCompletion.completed} of {activeCompletion.total})</span>
              </div>
              <div className="w-full bg-stone-100 h-2.5 rounded-full overflow-hidden border border-neutral-250">
                <div className="h-full bg-emerald-500 transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
            </div>

            <div className="flex justify-between items-center gap-4">
              <p className="text-[10px] text-neutral-400 font-light leading-snug">Submit this section when the configured checks are complete. A new checklist begins automatically on the next store business date.</p>
              <button
                type="button"
                onClick={submitCategory}
                disabled={actionsDisabled || checklistFlight.isBusy || !allDone}
                title={actionsDisabled
                  ? STALE_STATE_MESSAGE
                  : activeTasks.length === 0
                    ? 'No checklist is configured for this category.'
                    : !allDone
                      ? 'Complete every configured check before submitting this section.'
                      : checklistFlight.isBusy
                        ? 'A checklist change is already being saved.'
                        : undefined}
                className="bg-[#A46832] hover:bg-[#2E2A26] text-white py-3.5 px-6 rounded-full text-2xs font-extrabold uppercase tracking-widest transition-colors shrink-0 cursor-pointer border-0 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Submit checklist
              </button>
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 bg-white p-6 rounded-3xl border border-[#EBDECE] space-y-4 shadow-sm">
          <div className="flex items-center space-x-1.5 text-[#A46832]">
            <ListChecks className="h-4 w-4" />
            <h3 className="font-display text-xs uppercase font-extrabold tracking-widest">Submission history</h3>
          </div>
          <p className="text-3xs text-neutral-400 leading-relaxed font-light">Submitted store audit records. These entries are loaded from the shared database for authorised review:</p>

          {audits.length === 0 ? (
            <div className="py-6 text-center border border-dashed border-[#EBDECE] rounded-2xl">
              <p className="text-3xs text-neutral-400">No checklist audits have been recorded yet.</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
              {audits.map((audit) => (
                <div key={audit.id} className="p-3 bg-[#FBFBFC] rounded-xl border border-neutral-150 text-3xs space-y-1.5">
                  <div className="flex justify-between items-center border-b border-neutral-100 pb-1.5">
                    <span className="font-bold text-[#A46832] uppercase">{audit.category} Checks</span>
                    <span className="font-mono text-emerald-600 font-black">{audit.completedCount}/{audit.totalCount} Done</span>
                  </div>
                  <div>
                    <p className="font-medium text-neutral-700">Conductor: {audit.submittedBy}</p>
                    <p className="text-neutral-400">Signed At: {audit.submittedAt}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default React.memo(StaffChecklistPanel);
