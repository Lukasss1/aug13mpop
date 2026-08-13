/** Pure grouping/order projection for staff checklist templates. */
import type { ChecklistTemplateItem } from '../../types';

export const ADMIN_CHECKLIST_CATEGORIES = ['opening', 'midday', 'closing'] as const;
export type AdminChecklistCategory = typeof ADMIN_CHECKLIST_CATEGORIES[number];

export interface AdminChecklistGroup {
  category: AdminChecklistCategory;
  items: ChecklistTemplateItem[];
  count: number;
  nextSortOrder: number;
}

export function buildAdminChecklistGroups(items: ChecklistTemplateItem[]): Record<AdminChecklistCategory, AdminChecklistGroup> {
  const output = {} as Record<AdminChecklistCategory, AdminChecklistGroup>;
  for (const category of ADMIN_CHECKLIST_CATEGORIES) {
    const categoryItems = items
      .filter((item) => item.category === category)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
    output[category] = {
      category,
      items: categoryItems,
      count: categoryItems.length,
      nextSortOrder: categoryItems.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1,
    };
  }
  return output;
}
