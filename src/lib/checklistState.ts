import type { ChecklistTemplateItem } from '../types';

export interface ChecklistItem {
  id: string;
  task: string;
  category: 'opening' | 'midday' | 'closing';
  completed: boolean;
  completedBy?: string | undefined;
  completedAt?: string | undefined;
  comment?: string | undefined;
}

export interface StoreChecklistState {
  businessDate: string;
  tasks: ChecklistItem[];
}

export interface ChecklistAuditLog {
  id: string;
  businessDate?: string;
  submittedAt: string;
  submittedBy: string;
  submittedById?: string;
  storeName: string;
  category: 'opening' | 'midday' | 'closing';
  completedCount: number;
  totalCount: number;
  items: ChecklistItem[];
}

/** Reconcile today's mutable state against the latest manager-owned template. */
export function reconcileChecklistTasks(
  templates: ChecklistTemplateItem[],
  previous: ChecklistItem[] = [],
): ChecklistItem[] {
  const previousById = new Map(previous.map((task) => [task.id, task]));
  return [...templates]
    .sort((a, b) => a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder)
    .map((template) => {
      const old = previousById.get(template.id);
      return {
        id: template.id,
        task: template.label,
        category: template.category,
        completed: old?.completed ?? false,
        completedBy: old?.completedBy,
        completedAt: old?.completedAt,
        comment: old?.comment,
      };
    });
}

/**
 * Read only the current store-local business day. Legacy arrays and stale-day
 * envelopes are intentionally reset from the authoritative templates.
 */
export function readChecklistState(
  raw: unknown,
  businessDate: string,
  templates: ChecklistTemplateItem[],
): ChecklistItem[] {
  if (!templates.length) return [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const envelope = raw as Partial<StoreChecklistState>;
    if (envelope.businessDate === businessDate && Array.isArray(envelope.tasks)) {
      return reconcileChecklistTasks(templates, envelope.tasks);
    }
  }
  return reconcileChecklistTasks(templates);
}
