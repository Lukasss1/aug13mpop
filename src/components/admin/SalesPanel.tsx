/**
 * Read-only Web Till ledger.
 *
 * The panel owns only presentation state (filters, expanded row and the
 * store-local day rollover). Keeping that state outside AdminPanel prevents a
 * filter click from re-rendering the entire owner workspace. Financial writes
 * remain deliberately absent: refunds and voids belong to the authoritative
 * till/payment workflow.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { Order, StoreLocation } from '../../types';
import { msUntilNextBusinessDay } from '../../lib/businessDate';
import {
  buildAdminSalesModel,
  type AdminSalesChannelFilter,
  type AdminSalesStatusFilter,
} from './adminSales';

interface SalesPanelProps {
  orders: Order[];
  stores: StoreLocation[];
  currencySymbol: string;
}

export const SalesPanel = React.memo(function SalesPanel({
  orders,
  stores,
  currencySymbol,
}: SalesPanelProps) {
  const [statusFilter, setStatusFilter] = useState<AdminSalesStatusFilter>('all');
  const [channelFilter, setChannelFilter] = useState<AdminSalesChannelFilter>('all');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [businessDayRevision, setBusinessDayRevision] = useState(0);

  // The component exists only while the Sales route is open, so the timer is
  // automatically removed on navigation. The key prevents unrelated store
  // field changes from needlessly rescheduling the boundary.
  const timezoneKey = useMemo(() => {
    const zones = [...new Set(stores.map((store) => store.timezone || 'Europe/London'))].sort();
    return (zones.length ? zones : ['Europe/London']).join('\u0000');
  }, [stores]);

  useEffect(() => {
    const zones = timezoneKey.split('\u0000').filter(Boolean);
    const rawDelay = Math.min(...zones.map((timezone) => msUntilNextBusinessDay(timezone)));
    const delay = Number.isFinite(rawDelay) ? Math.max(1_000, rawDelay) : 60_000;
    const timer = window.setTimeout(
      () => setBusinessDayRevision((revision) => revision + 1),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [timezoneKey, businessDayRevision]);

  const model = useMemo(
    () => buildAdminSalesModel(orders, stores, statusFilter, channelFilter),
    [orders, stores, statusFilter, channelFilter, businessDayRevision],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h1 className="font-display font-black text-2xl">Web Till Orders</h1>
          <p className="text-2xs text-[#2E2A26]/70">Orders taken through the <b>website backup till</b> — searchable and synced to the cloud database when connected. This is <b>not</b> the tablet POS or the card terminal: refunds and voids are recorded through the authoritative till/payment workflow, while this browser ledger remains append-only. Native till takings live in <b>Native Till Ledger</b>, and the two channels are reported separately.</p>
        </div>
      </div>

      <div className="rounded-xl border border-[#EBDECE] bg-[#FBF6EE] px-3 py-2 text-[11px] text-[#2E2A26]/70">
        Scope: <b>Web backup till only</b> · all stores · completed-order revenue only; refunds and voids are shown separately.
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Web till — today', value: `${currencySymbol}${model.revenueToday.toFixed(2)}`, sub: `${model.completedTodayCount} web orders today` },
          { label: 'Web till — all-time', value: `${currencySymbol}${model.revenueAll.toFixed(2)}`, sub: `${model.completedCount} completed web orders` },
          { label: 'Average ticket', value: `${currencySymbol}${model.averageTicket.toFixed(2)}`, sub: 'completed web orders' },
          { label: 'Refunded (web)', value: String(model.refundedCount), sub: `${model.voidedCount} voided` },
        ].map((kpi) => (
          <div key={kpi.label} className="bg-white rounded-2xl border border-[#EBDECE] p-4 shadow-2xs">
            <p className="text-[10px] uppercase tracking-widest text-[#A46832] font-black">{kpi.label}</p>
            <p className="text-xl font-black text-[#2E2A26] mt-1">{kpi.value}</p>
            <p className="text-[10px] text-[#2E2A26]/50">{kpi.sub}</p>
          </div>
        ))}
      </div>

      {model.topProducts.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#EBDECE] p-5 shadow-2xs">
          <h3 className="text-2xs uppercase tracking-widest font-black text-[#2E2A26] mb-3">Top sellers</h3>
          <div className="space-y-2">
            {model.topProducts.map((product) => (
              <div key={product.menuItemId} className="flex items-center gap-3">
                <span className="text-2xs font-bold text-[#2E2A26] w-40 truncate">{product.name}</span>
                <div className="flex-1 h-2.5 bg-[#F7EFE6] rounded-full overflow-hidden">
                  <div className="h-full bg-[#A46832] rounded-full" style={{ width: `${(product.quantity / (model.topProducts[0]?.quantity || 1)) * 100}%` }} />
                </div>
                <span className="text-2xs text-[#2E2A26]/60 w-28 text-right">{product.quantity} sold · {currencySymbol}{product.revenue.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-[#EBDECE] shadow-2xs overflow-hidden">
        <div className="p-4 border-b border-[#EBDECE] flex flex-wrap gap-2 items-center">
          <select
            aria-label="Filter web orders by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as AdminSalesStatusFilter)}
            className="bg-stone-50 border border-[#EBDECE] text-2xs px-3 py-2 rounded-xl outline-none"
          >
            <option value="all">All statuses</option>
            <option value="completed">Completed</option>
            <option value="refunded">Refunded</option>
            <option value="voided">Voided</option>
          </select>
          <select
            aria-label="Filter web orders by channel"
            value={channelFilter}
            onChange={(event) => setChannelFilter(event.target.value as AdminSalesChannelFilter)}
            className="bg-stone-50 border border-[#EBDECE] text-2xs px-3 py-2 rounded-xl outline-none"
          >
            <option value="all">All channels</option>
            <option value="walk_in">Walk-in</option>
            <option value="phone">Phone</option>
            <option value="deliveroo">Deliveroo</option>
            <option value="uber_eats">Uber Eats</option>
            <option value="just_eat">Just Eat</option>
            <option value="website">Website</option>
          </select>
          <span className="text-2xs text-[#2E2A26]/50 ml-auto">{model.visibleOrders.length} orders</span>
        </div>

        {model.visibleOrders.length === 0 && (
          <div className="p-10 text-center text-2xs text-[#2E2A26]/50">
            No orders yet. Staff can ring sales through the Till (Staff Portal → Till / POS).
          </div>
        )}

        <div className="divide-y divide-[#EBDECE]/70">
          {model.visibleOrders.slice(0, 60).map((order) => {
            const expanded = expandedOrderId === order.id;
            return (
              <div key={order.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpandedOrderId(expanded ? null : order.id)}
                  className="w-full p-4 flex flex-wrap items-center gap-3 text-left hover:bg-[#F7EFE6]/40 cursor-pointer"
                >
                  <span className="text-xs font-black text-[#2E2A26] w-16">#{order.orderNumber}</span>
                  <span className="text-2xs text-[#2E2A26]/60 w-36">{model.placedAtLabels.get(order.id) || 'Time unavailable'}</span>
                  <span className="text-2xs text-[#2E2A26]/70 w-28 capitalize">{order.channel.replace('_', ' ')}</span>
                  <span className="text-2xs text-[#2E2A26]/70 flex-1 truncate">{order.items.length} item{order.items.length !== 1 ? 's' : ''} · {order.staffName}{order.customerName ? ` · for ${order.customerName}` : ''}</span>
                  <span className={`text-[9px] px-2 py-1 rounded-full font-black uppercase ${order.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : order.status === 'refunded' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-600'}`}>{order.status}</span>
                  <span className="text-xs font-black text-[#2E2A26] w-20 text-right">{currencySymbol}{order.total.toFixed(2)}</span>
                </button>

                {expanded && (
                  <div className="px-5 pb-4 bg-[#F7EFE6]/30">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-2xs">
                      <div className="space-y-1.5">
                        {order.items.map((item) => (
                          <div key={item.id} className="flex justify-between">
                            <span className="text-[#2E2A26]">{item.quantity}× {item.name}{item.size !== 'one_size' ? ` (${item.size})` : ''}{item.modifiers.length ? ` + ${item.modifiers.map((modifier) => modifier.name).join(', ')}` : ''}</span>
                            <span className="font-bold">{currencySymbol}{item.lineTotal.toFixed(2)}</span>
                          </div>
                        ))}
                        {order.appliedDeals.map((deal) => (
                          <div key={deal.dealId} className="flex justify-between text-emerald-700 font-bold"><span>{deal.dealName}</span><span>−{currencySymbol}{deal.discount.toFixed(2)}</span></div>
                        ))}
                        <div className="flex justify-between text-[#2E2A26]/60 pt-1 border-t border-[#EBDECE]">
                          <span>{order.storeVatStatus === 'NOT_REGISTERED' || (order.taxRate === 0 && order.taxAmount === 0)
                            ? 'VAT — not VAT registered'
                            : order.taxRate == null ? 'VAT (mixed rates, incl.)' : `VAT ${order.taxRate}% (incl.)`}</span>
                          <span>{currencySymbol}{order.taxAmount.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between font-black"><span>Total ({order.paymentMethod})</span><span>{currencySymbol}{order.total.toFixed(2)}</span></div>
                      </div>
                      <div className="flex flex-col justify-between gap-3">
                        <p className="text-[#2E2A26]/60">{order.storeName}{order.refundReason ? ` · Refund note: ${order.refundReason}` : ''}</p>
                        {order.status === 'completed' && (
                          <div className="flex gap-2">
                            <span className="px-4 py-2 bg-stone-100 text-stone-500 rounded-full text-[9px] uppercase font-black cursor-not-allowed" title="Refunds are recorded on the till as append-only events (pos-ingest) — this panel cannot rewrite a completed sale. Central refund records for web orders arrive post-launch.">Refund — on the till only</span>
                            <span className="px-4 py-2 bg-stone-100 text-stone-500 rounded-full text-[9px] uppercase font-black cursor-not-allowed" title="Voids are recorded on the till as append-only events (pos-ingest) — this panel cannot rewrite a completed sale.">Void — on the till only</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
