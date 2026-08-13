/** Pure status projection for the customer mailbox. */
import type { ContactMessage } from '../../types';

export type AdminContactFilter = ContactMessage['status'] | 'all';

export interface AdminContactMailboxModel {
  counts: Record<AdminContactFilter, number>;
  visibleMessages: ContactMessage[];
}

export function buildAdminContactMailbox(
  messages: ContactMessage[],
  filter: AdminContactFilter,
): AdminContactMailboxModel {
  const counts: Record<AdminContactFilter, number> = {
    new: 0,
    replied: 0,
    closed: 0,
    all: messages.length,
  };
  for (const message of messages) counts[message.status] += 1;
  return {
    counts,
    visibleMessages: filter === 'all' ? messages : messages.filter((message) => message.status === filter),
  };
}
