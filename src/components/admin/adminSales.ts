/** Pure projection for the read-only Web Till Orders ledger. */
import type { Order, OrderChannel, OrderStatus, StoreLocation } from '../../types';
import { businessDateISOAt } from '../../lib/businessDate';

export type AdminSalesStatusFilter = 'all' | OrderStatus;
export type AdminSalesChannelFilter = 'all' | OrderChannel;

export interface AdminTopProduct {
  menuItemId: string;
  name: string;
  quantity: number;
  revenue: number;
}

export interface AdminSalesModel {
  completedCount: number;
  completedTodayCount: number;
  revenueToday: number;
  revenueAll: number;
  averageTicket: number;
  refundedCount: number;
  voidedCount: number;
  topProducts: AdminTopProduct[];
  visibleOrders: Order[];
  placedAtLabels: Map<string, string>;
}

export function buildAdminSalesModel(
  orders: Order[],
  stores: StoreLocation[],
  statusFilter: AdminSalesStatusFilter,
  channelFilter: AdminSalesChannelFilter,
  now: Date = new Date(),
): AdminSalesModel {
  const timezoneByStoreId = new Map(stores.map((store) => [store.id, store.timezone || 'Europe/London']));
  const currentBusinessDateByTimezone = new Map<string, string>();
  const products = new Map<string, AdminTopProduct>();
  const visibleOrders: Order[] = [];
  let completedCount = 0;
  let completedTodayCount = 0;
  let revenueToday = 0;
  let revenueAll = 0;
  let refundedCount = 0;
  let voidedCount = 0;

  for (const order of orders) {
    if ((statusFilter === 'all' || order.status === statusFilter)
      && (channelFilter === 'all' || order.channel === channelFilter)) {
      visibleOrders.push(order);
    }
    if (order.status === 'refunded') {
      refundedCount += 1;
      continue;
    }
    if (order.status === 'voided') {
      voidedCount += 1;
      continue;
    }
    if (order.status !== 'completed') continue;

    completedCount += 1;
    revenueAll += order.total;
    const timezone = timezoneByStoreId.get(order.storeId) || 'Europe/London';
    let currentBusinessDate = currentBusinessDateByTimezone.get(timezone);
    if (!currentBusinessDate) {
      currentBusinessDate = businessDateISOAt(now, timezone);
      currentBusinessDateByTimezone.set(timezone, currentBusinessDate);
    }
    const orderDate = businessDateISOAt(order.placedAt, timezone);
    if (orderDate !== '' && orderDate === currentBusinessDate) {
      completedTodayCount += 1;
      revenueToday += order.total;
    }

    for (const item of order.items) {
      const existing = products.get(item.menuItemId);
      if (existing) {
        existing.quantity += item.quantity;
        existing.revenue += item.lineTotal;
      } else {
        products.set(item.menuItemId, {
          menuItemId: item.menuItemId,
          name: item.name,
          quantity: item.quantity,
          revenue: item.lineTotal,
        });
      }
    }
  }

  const topProducts = [...products.values()]
    .sort((left, right) =>
      right.quantity - left.quantity
      || right.revenue - left.revenue
      || left.name.localeCompare(right.name)
      || left.menuItemId.localeCompare(right.menuItemId))
    .slice(0, 5);

  const placedAtLabels = new Map<string, string>();
  for (const order of visibleOrders) {
    const date = new Date(order.placedAt);
    if (!Number.isFinite(date.getTime())) {
      placedAtLabels.set(order.id, 'Time unavailable');
      continue;
    }
    const timezone = timezoneByStoreId.get(order.storeId) || 'Europe/London';
    try {
      placedAtLabels.set(order.id, new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date));
    } catch {
      placedAtLabels.set(order.id, date.toLocaleString('en-GB', {
        timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      }));
    }
  }

  return {
    completedCount,
    completedTodayCount,
    revenueToday,
    revenueAll,
    averageTicket: completedCount ? revenueAll / completedCount : 0,
    refundedCount,
    voidedCount,
    topProducts,
    visibleOrders,
    placedAtLabels,
  };
}
