import React, { useState } from 'react';
import { Edit, Trash } from 'lucide-react';
import type { Deal, MenuItem, PublishableContentTable } from '../../types';
import { createClientId } from '../../lib/clientId';
import { useSingleFlight } from '../../hooks/useSingleFlight';
import { PublicationBadge, PublishButton } from './PublicationControls';
import { freshDealDraft, normaliseDealDraft } from './adminDeals';


type NumericDealField = 'buyQty' | 'bundlePrice' | 'freeQty' | 'percentOff' | 'amountOff' | 'minOrderValue';

function updateOptionalNumber(draft: Partial<Deal>, field: NumericDealField, raw: string): Partial<Deal> {
  const next = { ...draft };
  if (raw === '') {
    if (field === 'buyQty') delete next.buyQty;
    else if (field === 'bundlePrice') delete next.bundlePrice;
    else if (field === 'freeQty') delete next.freeQty;
    else if (field === 'percentOff') delete next.percentOff;
    else if (field === 'amountOff') delete next.amountOff;
    else delete next.minOrderValue;
    return next;
  }
  const value = Number(raw);
  if (field === 'buyQty') next.buyQty = value;
  else if (field === 'bundlePrice') next.bundlePrice = value;
  else if (field === 'freeQty') next.freeQty = value;
  else if (field === 'percentOff') next.percentOff = value;
  else if (field === 'amountOff') next.amountOff = value;
  else next.minOrderValue = value;
  return next;
}

interface DealsPanelProps {
  deals: Deal[];
  currencySymbol: string;
  canPublish: boolean;
  publicationBusyAction: string | null;
  onTogglePublication: (table: PublishableContentTable, id: string, publish: boolean, label: string) => Promise<void>;
  publishDeals: (next: Deal[] | ((previous: Deal[]) => Deal[])) => Promise<boolean>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  logAction: (module: string, action: string) => void;
}

export const DealsPanel = React.memo(function DealsPanel({
  deals,
  currencySymbol,
  canPublish,
  publicationBusyAction,
  onTogglePublication,
  publishDeals,
  addToast,
  logAction,
}: DealsPanelProps) {
  const [draft, setDraft] = useState<Partial<Deal>>(() => freshDealDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const mutation = useSingleFlight();
  const busy = mutation.isBusy || publicationBusyAction !== null;

  const resetEditor = () => {
    setEditingId(null);
    setDraft(freshDealDraft());
  };

  const editDeal = (deal: Deal) => {
    setEditingId(deal.id);
    setDraft({ ...deal });
  };

  const saveDeal = async () => mutation.run('deal:save', async () => {
    const result = normaliseDealDraft(draft);
    if (!result.ok) {
      addToast(result.message, result.tone);
      return;
    }

    if (editingId) {
      const saved = await publishDeals((previous) => previous.map((item) =>
        item.id === editingId ? { ...result.value, id: editingId } : item));
      if (!saved) return;
      logAction('Deals', `Updated deal "${result.value.name}"`);
      addToast('Deal updated.', 'success');
    } else {
      const newDeal: Deal = { ...result.value, active: false, id: createClientId('deal') };
      const saved = await publishDeals((previous) => [newDeal, ...previous]);
      if (!saved) return;
      logAction('Deals', `Created deal "${newDeal.name}" (draft)`);
      addToast('Deal created as a draft — press Publish to put it live.', 'success');
    }
    resetEditor();
  });

  const deleteDeal = async (deal: Deal) => mutation.run(`deal:delete:${deal.id}`, async () => {
    if (deal.active) {
      addToast(`"${deal.name}" is live — unpublish it before deleting.`, 'error');
      return;
    }
    if (!window.confirm(`Delete deal "${deal.name}"?`)) return;
    const saved = await publishDeals((previous) => previous.filter((item) => item.id !== deal.id));
    if (!saved) return;
    logAction('Deals', `Deleted deal "${deal.name}"`);
    if (editingId === deal.id) resetEditor();
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display font-black text-2xl">Deals &amp; Combos</h1>
        <p className="text-2xs text-[#2E2A26]/70">Promotions apply automatically at the Till and show on the public menu — including the brandbook combos “1+1” and “1+1=3”.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-3">
          {deals.map((deal) => (
            <div key={deal.id} className={`bg-white rounded-2xl border p-4 shadow-2xs flex flex-wrap items-center gap-3 ${deal.active ? 'border-[#7CC0C7]' : 'border-[#EBDECE] opacity-70'}`}>
              <span className="px-2.5 py-1 bg-[#A46832] text-white rounded-full text-[10px] font-black">{deal.badge || '%'}</span>
              <div className="flex-1 min-w-40">
                <p className="text-xs font-bold text-[#2E2A26]">{deal.name}</p>
                <p className="text-[10px] text-[#2E2A26]/60">{deal.description}</p>
              </div>
              <PublicationBadge live={!!deal.active} />
              <PublishButton
                table="deals"
                canPublish={canPublish}
                busyAction={publicationBusyAction}
                onToggle={onTogglePublication}
                id={deal.id}
                live={!!deal.active}
                label={`Deal "${deal.name}"`}
              />
              <button type="button" aria-label={`Edit deal ${deal.name}`} disabled={busy} onClick={() => editDeal(deal)} className="min-h-11 min-w-11 rounded-full grid place-items-center hover:bg-[#F7EFE6] cursor-pointer disabled:opacity-50">
                <Edit className="h-3.5 w-3.5 text-[#A46832]" />
              </button>
              <button type="button" aria-label={`Delete deal ${deal.name}`} disabled={busy} onClick={() => { void deleteDeal(deal); }} className="min-h-11 min-w-11 rounded-full grid place-items-center hover:bg-red-50 cursor-pointer disabled:opacity-50">
                <Trash className="h-3.5 w-3.5 text-red-500" />
              </button>
            </div>
          ))}
          {deals.length === 0 && <p className="text-2xs text-[#2E2A26]/50 p-6 text-center bg-white rounded-2xl border border-[#EBDECE]">No deals yet — create the first combo on the right.</p>}
        </div>

        <div className="lg:col-span-5 bg-white rounded-2xl border border-[#EBDECE] p-5 shadow-2xs space-y-3 text-2xs">
          <h3 className="font-display font-black text-xs uppercase tracking-wide border-b border-[#EBDECE] pb-2">{editingId ? 'Edit deal' : 'Create a deal'}</h3>
          <div className="space-y-1"><label htmlFor="deal-name" className="font-bold block">Name</label>
            <input id="deal-name" value={draft.name || ''} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none focus:border-[#A46832]" placeholder="e.g. Two Milkshakes Combo" /></div>
          <div className="space-y-1"><label htmlFor="deal-description" className="font-bold block">Description (shown on the menu)</label>
            <input id="deal-description" value={draft.description || ''} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none focus:border-[#A46832]" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><label htmlFor="deal-badge" className="font-bold block">Badge</label>
              <input id="deal-badge" value={draft.badge || ''} onChange={(event) => setDraft((current) => ({ ...current, badge: event.target.value }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" placeholder="1+1=3" /></div>
            <div className="space-y-1"><label htmlFor="deal-mechanic" className="font-bold block">Mechanic</label>
              <select id="deal-mechanic" value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as Deal['type'] }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none">
                <option value="bundle_price">Bundle price (X for £Y)</option>
                <option value="buy_x_get_y_free">Buy X get Y free</option>
                <option value="percent_off_category">% off a category</option>
                <option value="fixed_off_order">£ off the order</option>
              </select></div>
          </div>
          {(draft.type === 'bundle_price' || draft.type === 'buy_x_get_y_free' || draft.type === 'percent_off_category') && (
            <div className="space-y-1"><label htmlFor="deal-category" className="font-bold block">Category</label>
              <select id="deal-category" value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value as MenuItem['category'] }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none">
                <option value="milkshakes">Milkshakes</option><option value="smoothies">Smoothies</option><option value="soft_serve">Soft Serve</option><option value="slush">Slush</option><option value="extras">Extras</option>
              </select></div>
          )}
          {draft.type === 'bundle_price' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><label htmlFor="deal-buy-quantity" className="font-bold block">Buy quantity</label>
                <input id="deal-buy-quantity" type="number" min={2} value={draft.buyQty ?? ''} onChange={(event) => setDraft((current) => updateOptionalNumber(current, 'buyQty', event.target.value))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" /></div>
              <div className="space-y-1"><label htmlFor="deal-bundle-price" className="font-bold block">Bundle price ({currencySymbol})</label>
                <input id="deal-bundle-price" type="number" min={0} step={0.5} value={draft.bundlePrice ?? ''} onChange={(event) => setDraft((current) => updateOptionalNumber(current, 'bundlePrice', event.target.value))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" /></div>
            </div>
          )}
          {draft.type === 'buy_x_get_y_free' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><label htmlFor="deal-free-buy-quantity" className="font-bold block">Buy quantity</label>
                <input id="deal-free-buy-quantity" type="number" min={1} value={draft.buyQty ?? ''} onChange={(event) => setDraft((current) => updateOptionalNumber(current, 'buyQty', event.target.value))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" /></div>
              <div className="space-y-1"><label htmlFor="deal-free-quantity" className="font-bold block">Free quantity</label>
                <input id="deal-free-quantity" type="number" min={1} value={draft.freeQty ?? ''} onChange={(event) => setDraft((current) => updateOptionalNumber(current, 'freeQty', event.target.value))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" /></div>
            </div>
          )}
          {draft.type === 'percent_off_category' && (
            <div className="space-y-1"><label htmlFor="deal-percent-off" className="font-bold block">Percent off</label>
              <input id="deal-percent-off" type="number" min={1} max={100} value={draft.percentOff ?? ''} onChange={(event) => setDraft((current) => updateOptionalNumber(current, 'percentOff', event.target.value))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" /></div>
          )}
          {draft.type === 'fixed_off_order' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><label htmlFor="deal-amount-off" className="font-bold block">Amount off ({currencySymbol})</label>
                <input id="deal-amount-off" type="number" min={0} step={0.5} value={draft.amountOff ?? ''} onChange={(event) => setDraft((current) => updateOptionalNumber(current, 'amountOff', event.target.value))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" /></div>
              <div className="space-y-1"><label htmlFor="deal-min-order" className="font-bold block">Min order ({currencySymbol})</label>
                <input id="deal-min-order" type="number" min={0} step={0.5} value={draft.minOrderValue ?? ''} onChange={(event) => setDraft((current) => updateOptionalNumber(current, 'minOrderValue', event.target.value))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" /></div>
            </div>
          )}
          <div className="flex gap-2 pt-2 border-t border-[#EBDECE]">
            <button type="button" onClick={() => { void saveDeal(); }} disabled={busy} className="flex-1 py-2.5 bg-[#A46832] hover:bg-[#A5642B] text-white rounded-full uppercase font-black tracking-wider cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
              {mutation.activeKey === 'deal:save' ? 'Saving…' : editingId ? 'Save changes' : 'Create deal'}
            </button>
            {editingId && <button type="button" disabled={busy} onClick={resetEditor} className="px-4 py-2.5 bg-stone-100 text-stone-600 rounded-full uppercase font-black tracking-wider cursor-pointer disabled:opacity-50">Cancel</button>}
          </div>
        </div>
      </div>
    </div>
  );
});
