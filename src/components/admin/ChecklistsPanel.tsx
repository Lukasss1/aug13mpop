import React, { useMemo, useState } from 'react';
import { Edit, Trash } from 'lucide-react';
import type { ChecklistTemplateItem } from '../../types';
import { createClientId } from '../../lib/clientId';
import { useSingleFlight } from '../../hooks/useSingleFlight';
import { ADMIN_CHECKLIST_CATEGORIES, buildAdminChecklistGroups } from './adminChecklists';

interface ChecklistsPanelProps {
  templates: ChecklistTemplateItem[];
  publishTemplates: (next: ChecklistTemplateItem[] | ((previous: ChecklistTemplateItem[]) => ChecklistTemplateItem[])) => Promise<boolean>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  logAction: (module: string, action: string) => void;
}

const freshChecklistDraft = (): Partial<ChecklistTemplateItem> => ({ label: '', category: 'opening', critical: false });

export const ChecklistsPanel = React.memo(function ChecklistsPanel({
  templates,
  publishTemplates,
  addToast,
  logAction,
}: ChecklistsPanelProps) {
  const [draft, setDraft] = useState<Partial<ChecklistTemplateItem>>(() => freshChecklistDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const groups = useMemo(() => buildAdminChecklistGroups(templates), [templates]);
  const mutation = useSingleFlight();

  const resetEditor = () => {
    setEditingId(null);
    setDraft(freshChecklistDraft());
  };

  const saveTask = async () => mutation.run('checklist:save', async () => {
    const label = String(draft.label || '').trim();
    const category = draft.category || 'opening';
    if (!label) {
      addToast('Describe the task first.', 'warning');
      return;
    }
    const duplicate = templates.some((item) =>
      item.id !== editingId
      && item.category === category
      && item.label.trim().toLowerCase() === label.toLowerCase());
    if (duplicate) {
      addToast('That checklist task already exists in this shift phase.', 'warning');
      return;
    }

    if (editingId) {
      const saved = await publishTemplates((previous) => previous.map((item) =>
        item.id === editingId
          ? { ...item, label, category, critical: !!draft.critical }
          : item));
      if (!saved) return;
      logAction('Checklists', `Updated checklist task "${label}"`);
      addToast('Checklist task updated for all staff.', 'success');
    } else {
      const newTask: ChecklistTemplateItem = {
        id: createClientId('ck'),
        label,
        category,
        critical: !!draft.critical,
        sortOrder: groups[category].nextSortOrder,
      };
      const saved = await publishTemplates((previous) => [...previous, newTask]);
      if (!saved) return;
      logAction('Checklists', `Added checklist task "${label}"`);
      addToast('Task added — it is live on the Staff Portal now.', 'success');
    }
    resetEditor();
  });

  const deleteTask = async (task: ChecklistTemplateItem) => mutation.run(`checklist:delete:${task.id}`, async () => {
    if (!window.confirm(`Delete checklist task "${task.label}"?`)) return;
    const saved = await publishTemplates((previous) => previous.filter((item) => item.id !== task.id));
    if (!saved) return;
    logAction('Checklists', `Removed checklist task "${task.label}"`);
    addToast('Checklist task deleted.', 'warning');
    if (editingId === task.id) resetEditor();
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display font-black text-2xl">Staff Shift Checklists</h1>
        <p className="text-2xs text-[#2E2A26]/70">Every item here appears on the Staff Portal “Shift Checklists” screen in real time. Edit, reorder or retire procedures without touching code.</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-5">
          {ADMIN_CHECKLIST_CATEGORIES.map((category) => (
            <div key={category} className="bg-white rounded-2xl border border-[#EBDECE] shadow-2xs overflow-hidden">
              <div className="px-4 py-3 bg-[#F7EFE6]/60 border-b border-[#EBDECE] flex items-center justify-between">
                <h3 className="text-2xs uppercase tracking-widest font-black text-[#A46832]">{category} routine</h3>
                <span className="text-[10px] text-[#2E2A26]/50">{groups[category].count} tasks</span>
              </div>
              <div className="divide-y divide-[#EBDECE]/60">
                {groups[category].items.map((task) => (
                  <div key={task.id} className="px-4 py-3 flex items-center gap-3">
                    <span className="text-2xs text-[#2E2A26] flex-1">{task.label}</span>
                    {task.critical && <span className="text-[9px] px-2 py-0.5 bg-red-50 text-red-600 rounded-full font-black uppercase">Critical</span>}
                    <button type="button" aria-label={`Edit checklist task ${task.label}`} disabled={mutation.isBusy} onClick={() => { setEditingId(task.id); setDraft({ ...task }); }} className="min-h-11 min-w-11 rounded-full grid place-items-center hover:bg-[#F7EFE6] cursor-pointer disabled:opacity-50">
                      <Edit className="h-3.5 w-3.5 text-[#A46832]" />
                    </button>
                    <button type="button" aria-label={`Delete checklist task ${task.label}`} disabled={mutation.isBusy} onClick={() => { void deleteTask(task); }} className="min-h-11 min-w-11 rounded-full grid place-items-center hover:bg-red-50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                      <Trash className="h-3.5 w-3.5 text-red-500" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="lg:col-span-5 bg-white rounded-2xl border border-[#EBDECE] p-5 shadow-2xs space-y-3 text-2xs">
          <h3 className="font-display font-black text-xs uppercase tracking-wide border-b border-[#EBDECE] pb-2">{editingId ? 'Edit task' : 'Add a task'}</h3>
          <div className="space-y-1"><label htmlFor="checklist-task-description" className="font-bold block">Task description</label>
            <textarea id="checklist-task-description" rows={3} value={draft.label || ''} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none focus:border-[#A46832] resize-none" placeholder="e.g. Record fridge temperatures in the log" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><label htmlFor="checklist-task-phase" className="font-bold block">Shift phase</label>
              <select id="checklist-task-phase" value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value as ChecklistTemplateItem['category'] }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none">
                <option value="opening">Opening</option><option value="midday">Mid-day</option><option value="closing">Closing</option>
              </select></div>
            <label className="flex items-center gap-2 pt-5 cursor-pointer select-none">
              <input type="checkbox" checked={!!draft.critical} onChange={(event) => setDraft((current) => ({ ...current, critical: event.target.checked }))} className="h-4 w-4 rounded border-neutral-300" />
              <span className="font-bold">Critical task</span>
            </label>
          </div>
          <div className="flex gap-2 pt-2 border-t border-[#EBDECE]">
            <button type="button" onClick={() => { void saveTask(); }} disabled={mutation.isBusy} className="flex-1 py-2.5 bg-[#A46832] hover:bg-[#A5642B] text-white rounded-full uppercase font-black tracking-wider cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
              {mutation.activeKey === 'checklist:save' ? 'Saving…' : editingId ? 'Save changes' : 'Add task'}
            </button>
            {editingId && <button type="button" disabled={mutation.isBusy} onClick={resetEditor} className="px-4 py-2.5 bg-stone-100 text-stone-600 rounded-full uppercase font-black tracking-wider cursor-pointer disabled:opacity-50">Cancel</button>}
          </div>
        </div>
      </div>
    </div>
  );
});
