/**
 * Till History — integration plan Gate 6. The cloud read surface for the
 * iOS till: orders (with items, modifiers, refunds, voids, corrections),
 * closed-shift Z-reports and paired-device health, all read from the pos_*
 * tables through lib/posData.ts as the SIGNED-IN staff member. RLS scopes
 * everything: owners see every store, managers only their own.
 *
 * MANDATORY TEST #7: nothing here persists to the browser. Clearing site
 * data and signing back in shows the identical history, because the till —
 * not this browser — is the source and Supabase is the store.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, Receipt, Landmark, TabletSmartphone, ChevronDown, ChevronUp,
  Banknote, CreditCard, Undo2, Ban, PenLine, CloudOff, Download, Plus,
  KeyRound, ShieldOff, Copy, Clock,
} from 'lucide-react';
import {
  fetchPosOrders, fetchPosShifts, fetchPosDevices, normalizeVoid,
  createPairingCode, revokeDevice, rotateDeviceToken, ordersToCsv, shiftsToCsv,
  type PosOrder, type PosShift, type PosDevice, type FreshPairingCode,
} from '../../lib/posData';
import * as tp from '../../lib/tillPayments';
import * as tillLease from '../../lib/tillLease';
import * as legacyOutbox from '../../lib/orderOutbox';
import { businessTodayISO } from '../../lib/businessDate';

const gbp = (pence: number | undefined | null) =>
  typeof pence === 'number' ? `£${(pence / 100).toFixed(2)}` : '—';
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
}) : '—');

type LoadState = 'loading' | 'ok' | 'not_configured' | 'unauthenticated' | 'error';

interface TillOrdersProps {
  getAccessToken: () => Promise<string | null>;
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  /** Owner-only device actions (the database re-checks with is_owner()). */
  isOwner: boolean;
  /** Site stores, offered when minting a pairing code. */
  storeOptions: Array<{ id: string; name: string }>;
}

export const TillOrders: React.FC<TillOrdersProps> = ({ getAccessToken, addToast, isOwner, storeOptions }) => {
  const [state, setState] = useState<LoadState>('loading');
  const [orders, setOrders] = useState<PosOrder[]>([]);
  const [shifts, setShifts] = useState<PosShift[]>([]);
  const [devices, setDevices] = useState<PosDevice[]>([]);
  const [view, setView] = useState<'orders' | 'shifts' | 'devices' | 'recovery'>('orders');
  const [storeFilter, setStoreFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async (announce = false) => {
    setState('loading');
    const token = (await getAccessToken()) || '';
    const [o, s, d] = await Promise.all([
      fetchPosOrders(token, { limit: 300 }),
      fetchPosShifts(token, { limit: 150 }),
      fetchPosDevices(token),
    ]);
    if (o.status !== 'ok') { setState(o.status); return; }
    setOrders(o.rows);
    setShifts(s.status === 'ok' ? s.rows : []);
    setDevices(d.status === 'ok' ? d.rows : []);
    setState('ok');
    if (announce) addToast('Till history refreshed from the cloud.', 'success');
  };
  useEffect(() => { void load(); /* on mount */ }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  /** R4.3 (audit blocker): hold the till lease from PAGE LOAD, so a manager
   *  landing directly on Till orders can complete recovery without ever
   *  having visited the cashier POS in this tab. */
  useEffect(() => { void tillLease.acquireTillLease(); }, []);

  const stores = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of devices) map.set(d.storeId, d.storeName);
    for (const o of orders) if (!map.has(o.storeId)) map.set(o.storeId, o.storeId);
    return Array.from(map.entries());
  }, [devices, orders]);

  const visibleOrders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) =>
      (storeFilter === 'all' || o.storeId === storeFilter) &&
      (!q || o.visibleOrderNumber.toLowerCase().includes(q) ||
        (o.soldByName || '').toLowerCase().includes(q)));
  }, [orders, storeFilter, search]);

  const visibleShifts = useMemo(() =>
    shifts.filter((s) => storeFilter === 'all' || s.storeId === storeFilter),
  [shifts, storeFilter]);

  if (state === 'not_configured') {
    return (
      <Shell onRefresh={() => void load(true)}>
        <Empty icon={CloudOff} title="Cloud database not connected"
          body="Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, run supabase/migration_pos_sync.sql, and till history will appear here." />
      </Shell>
    );
  }
  if (state === 'unauthenticated') {
    return (
      <Shell onRefresh={() => void load(true)}>
        <Empty icon={CloudOff} title="Sign in again to view till history"
          body="Your session has expired or this account has no till-history access (owners and store managers only)." />
      </Shell>
    );
  }
  if (state === 'error') {
    return (
      <Shell onRefresh={() => void load(true)}>
        <Empty icon={CloudOff} title="Could not reach the cloud database"
          body="Check the connection and try Refresh." />
      </Shell>
    );
  }

  const exportCsv = () => {
    const csv = view === 'shifts' ? shiftsToCsv(visibleShifts) : ordersToCsv(visibleOrders);
    const stamp = businessTodayISO().replace(/-/g, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `milkpop-till-${view === 'shifts' ? 'shifts' : 'orders'}-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    addToast('CSV exported for the visible scope.', 'success');
  };

  return (
    <Shell onRefresh={() => void load(true)} busy={state === 'loading'}
      actions={view !== 'devices' && state === 'ok' ? (
        <button onClick={exportCsv}
          className="px-4 py-2 bg-white border border-[#2E2A26]/15 rounded-full text-2xs tracking-wider uppercase font-black flex items-center gap-1 cursor-pointer hover:bg-amber-50">
          <Download size={12} /> Export CSV
        </button>
      ) : undefined}>
      {/* view switch + filters */}
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="flex rounded-full border border-[#2E2A26]/15 overflow-hidden text-2xs font-black uppercase tracking-wider">
          {([['orders', 'Orders', Receipt], ['shifts', 'Shifts', Landmark], ['devices', 'Tills', TabletSmartphone], ['recovery', 'Recovery', Undo2]] as const)
            .map(([id, label, Icon]) => (
              <button key={id} onClick={() => { setOpenId(null); setView(id); }}
                className={`px-4 py-2 flex items-center gap-1.5 cursor-pointer ${view === id ? 'bg-[#2E2A26] text-white' : 'bg-white hover:bg-amber-50'}`}>
                <Icon size={12} /> {label}
              </button>
            ))}
        </div>
        {stores.length > 1 && (
          <select value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}
            className="px-3 py-2 rounded-full border border-[#2E2A26]/15 text-2xs font-bold bg-white">
            <option value="all">All stores</option>
            {stores.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        {view === 'orders' && (
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order № or staff…"
            className="flex-1 min-w-40 px-4 py-2 rounded-full border border-[#2E2A26]/15 text-xs bg-white" />
        )}
      </div>

      {state === 'loading' && <p className="text-2xs text-[#2E2A26]/60">Loading from the cloud…</p>}

      {state === 'ok' && view === 'orders' && (
        visibleOrders.length === 0 ? (
          <Empty icon={Receipt} title="No till orders yet"
            body={devices.length === 0
              ? 'No till is paired yet. Generate a pairing code (Devices, Gate 8) and connect the iOS till from Staff & settings.'
              : 'Paired tills will upload orders here as they sync.'} />
        ) : (
          <div className="bg-white rounded-2xl border border-[#2E2A26]/10 divide-y divide-[#2E2A26]/8 overflow-hidden">
            {visibleOrders.map((o) => {
              const v = normalizeVoid(o.voids);
              const refunded = (o.refunds || []).reduce((s, r) => s + r.amountPence, 0);
              const open = openId === o.id;
              return (
                <div key={o.id}>
                  <button onClick={() => setOpenId(open ? null : o.id)}
                    className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-amber-50/60 cursor-pointer">
                    {o.paymentMethod === 'cash'
                      ? <Banknote size={16} className="text-[#5FA777] shrink-0" />
                      : <CreditCard size={16} className="text-[#A46832] shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="font-black text-sm truncate">{o.visibleOrderNumber}</div>
                      <div className="text-2xs text-[#2E2A26]/60">
                        {when(o.occurredAt)}{o.soldByName ? ` · ${o.soldByName}` : ''} · {(o.items || []).length} item{(o.items || []).length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {v && <Badge tone="dark"><Ban size={10} /> Voided</Badge>}
                      {refunded > 0 && <Badge tone="amber"><Undo2 size={10} /> −{gbp(refunded)}</Badge>}
                      {(o.corrections || []).length > 0 && <Badge tone="plain"><PenLine size={10} /> Corrected</Badge>}
                    </div>
                    <div className="font-black text-sm w-16 text-right shrink-0">{gbp(o.totalPence)}</div>
                    {open ? <ChevronUp size={14} className="shrink-0" /> : <ChevronDown size={14} className="shrink-0" />}
                  </button>
                  {open && <OrderDetail order={o} />}
                </div>
              );
            })}
          </div>
        )
      )}

      {state === 'ok' && view === 'shifts' && (
        visibleShifts.length === 0 ? (
          <Empty icon={Landmark} title="No shifts yet" body="Opened and closed till shifts appear here with their Z-reports." />
        ) : (
          <div className="bg-white rounded-2xl border border-[#2E2A26]/10 divide-y divide-[#2E2A26]/8 overflow-hidden">
            {visibleShifts.map((s) => {
              const open = openId === s.id;
              const varSum = (s.cashVariancePence ?? 0) + (s.cardVariancePence ?? 0);
              return (
                <div key={s.id}>
                  <button onClick={() => setOpenId(open ? null : s.id)}
                    className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-amber-50/60 cursor-pointer">
                    <Landmark size={16} className="text-[#2E2A26]/60 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-black text-sm">{when(s.openedAt)} → {s.status === 'closed' ? when(s.closedAt) : 'open'}</div>
                      <div className="text-2xs text-[#2E2A26]/60">
                        {s.openedByName ? `Opened by ${s.openedByName}` : 'Opened'}{s.closedByName ? ` · closed by ${s.closedByName}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {s.status === 'open'
                        ? <Badge tone="green">Open</Badge>
                        : varSum === 0
                          ? <Badge tone="green">Balanced</Badge>
                          : <Badge tone="amber">Variance {gbp(varSum)}</Badge>}
                    </div>
                    {open ? <ChevronUp size={14} className="shrink-0" /> : <ChevronDown size={14} className="shrink-0" />}
                  </button>
                  {open && (
                    <div className="px-6 pb-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-2xs bg-[#FFFDF8]">
                      <Fig label="Opening float" value={gbp(s.openingCashPence)} />
                      <Fig label="Counted cash" value={gbp(s.countedCashPence)} />
                      <Fig label="Expected cash" value={gbp(s.expectedCashPence)} />
                      <Fig label="Cash variance" value={gbp(s.cashVariancePence)} />
                      <Fig label="Reported card" value={gbp(s.reportedCardPence)} />
                      <Fig label="Expected card" value={gbp(s.expectedCardPence)} />
                      <Fig label="Card variance" value={gbp(s.cardVariancePence)} />
                      <Fig label="Z-report stored" value={s.closeSummary ? 'Yes — verbatim from the till' : '—'} />
                      {s.varianceReason && <div className="col-span-2 md:col-span-4"><Fig label="Variance reason" value={s.varianceReason} /></div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {view === 'recovery' && (
        <RecoveryPanel getAccessToken={getAccessToken} addToast={addToast} />
      )}

      {state === 'ok' && view === 'devices' && (
        <DeviceManager devices={devices} isOwner={isOwner} storeOptions={storeOptions}
          getAccessToken={getAccessToken} addToast={addToast}
          onChanged={() => void load()} />
      )}
    </Shell>
  );
};

/* ------------------------------------------------------------------ */

const Shell: React.FC<{ onRefresh: () => void; busy?: boolean; actions?: React.ReactNode; children: React.ReactNode }> =
  ({ onRefresh, busy, actions, children }) => (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h1 className="font-display font-black text-2xl">Native Till Ledger</h1>
          <p className="text-2xs text-[#2E2A26]/70">
            Website-side integration for a compatible <b>native tablet till</b>: orders, shifts and Z-reports
            appear here after that separate till application has been supplied, paired and commissioned. The
            native app itself is not included in this website package. Uploaded ledger data is read live from
            the cloud database, scoped to your stores and read-only here; clearing this browser never touches it.
            Separate from <b>Web Till Orders</b>: the two channels are reported independently.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {actions}
          <button onClick={onRefresh} disabled={busy}
            className="px-4 py-2 bg-[#A46832] text-white rounded-full text-2xs tracking-wider uppercase font-black flex items-center gap-1 shadow-xs cursor-pointer disabled:opacity-50">
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>
      {children}
    </div>
  );

const Badge: React.FC<{ tone: 'green' | 'amber' | 'dark' | 'plain'; children: React.ReactNode }> =
  ({ tone, children }) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs font-black uppercase tracking-wider ${
      tone === 'green' ? 'bg-[#5FA777]/15 text-[#3E7A54]'
      : tone === 'amber' ? 'bg-amber-100 text-amber-800'
      : tone === 'dark' ? 'bg-[#2E2A26] text-white'
      : 'bg-[#2E2A26]/8 text-[#2E2A26]/70'}`}>
      {children}
    </span>
  );

const Fig: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div>
    <div className="text-3xs uppercase tracking-wider font-black text-[#2E2A26]/50">{label}</div>
    <div className="font-bold">{value}</div>
  </div>
);

const Empty: React.FC<{ icon: React.ComponentType<{ size?: number; className?: string }>; title: string; body: string }> =
  ({ icon: Icon, title, body }) => (
    <div className="bg-white rounded-2xl border border-[#2E2A26]/10 px-6 py-10 text-center space-y-2">
      <Icon size={22} className="mx-auto text-[#2E2A26]/40" />
      <div className="font-black">{title}</div>
      <p className="text-2xs text-[#2E2A26]/60 max-w-md mx-auto">{body}</p>
    </div>
  );

const OrderDetail: React.FC<{ order: PosOrder }> = ({ order: o }) => {
  const v = normalizeVoid(o.voids);
  return (
    <div className="px-6 pb-4 space-y-3 bg-[#FFFDF8] text-xs">
      <div className="pt-3 space-y-1.5">
        {(o.items || []).map((it) => (
          <div key={it.id}>
            <div className="flex justify-between gap-3">
              <span className="font-bold">{it.quantity} × {it.name} <span className="text-[#2E2A26]/50">({it.size.replace('_', ' ')})</span></span>
              <span className="font-bold">{gbp(it.lineTotalPence)}</span>
            </div>
            {(it.modifiers || []).map((m) => (
              <div key={m.id} className="flex justify-between gap-3 pl-4 text-2xs text-[#2E2A26]/60">
                <span>+ {m.name}</span><span>{gbp(m.pricePence)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {(o.appliedDeals || []).length > 0 && (
        <div className="text-2xs text-[#2E2A26]/70">
          {(o.appliedDeals || []).map((d, i) => (
            <div key={i} className="flex justify-between gap-3">
              <span>Deal: {String((d as Record<string, unknown>).name ?? (d as Record<string, unknown>).dealId ?? 'applied')}</span>
              {typeof (d as Record<string, unknown>).savingPence === 'number' &&
                <span>−{gbp((d as Record<string, unknown>).savingPence as number)}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-[#2E2A26]/10 pt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-2xs">
        <Fig label="Subtotal" value={gbp(o.subtotalPence)} />
        <Fig label="Discount" value={o.discountPence ? `−${gbp(o.discountPence)}` : '—'} />
        <Fig label="VAT inside" value={gbp(o.vatPence)} />
        <Fig label="Total" value={<span className="text-sm">{gbp(o.totalPence)}</span>} />
        {o.paymentMethod === 'cash' && (
          <>
            <Fig label="Cash received" value={gbp(o.cashReceivedPence)} />
            <Fig label="Change given" value={gbp(o.changeGivenPence)} />
          </>
        )}
        {o.paymentMethod === 'card' && o.manualCardConfirmation && (
          <Fig label="Card capture" value="Manually confirmed" />
        )}
        <Fig label="Till" value={`${o.storeCode} / ${o.deviceCode}`} />
      </div>
      {v && (
        <div className="rounded-xl bg-[#2E2A26] text-white px-3 py-2">
          <span className="font-black uppercase text-3xs tracking-wider">Voided</span>{' '}
          {when(v.occurredAt)} · {v.reason}
          {v.approvedByName ? ` · approved by ${v.approvedByName}` : ''}
          {v.method === 'card' ? ` · card terminal ${v.cardTerminalConfirmed ? 'reversal confirmed' : 'NOT confirmed'}` : ''}
        </div>
      )}
      {(o.refunds || []).map((r) => (
        <div key={r.id} className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2">
          <span className="font-black uppercase text-3xs tracking-wider text-amber-800">Refund</span>{' '}
          −{gbp(r.amountPence)} ({r.kind}, {r.method}) · {when(r.occurredAt)} · {r.reason}
          {r.approvedByName ? ` · approved by ${r.approvedByName}` : ''}
          {(r.items || []).length > 0 && (
            <div className="pl-3 pt-1 text-2xs text-[#2E2A26]/70">
              {(r.items || []).map((ri) => (
                <div key={ri.id}>{ri.quantity} × {ri.name ?? ri.orderItemId} — {gbp(ri.amountPence)}</div>
              ))}
            </div>
          )}
        </div>
      ))}
      {(o.corrections || []).map((c) => (
        <div key={c.id} className="rounded-xl bg-[#2E2A26]/5 px-3 py-2 text-2xs">
          <span className="font-black uppercase text-3xs tracking-wider">Correction</span>{' '}
          {c.kind === 'payment_method'
            ? `payment method ${String((c.beforePayload as Record<string, unknown>).paymentMethod ?? '?')} → ${String((c.afterPayload as Record<string, unknown>).paymentMethod ?? '?')}`
            : c.kind}
          {' · '}{when(c.occurredAt)} · {c.reason}
          {c.approvedByName ? ` · approved by ${c.approvedByName}` : ''}
        </div>
      ))}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Gate 8: device management (Owner actions; the database re-checks)    */
/* ------------------------------------------------------------------ */

const secondsLeft = (iso: string) => Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));

const copyText = async (text: string, addToast: TillOrdersProps['addToast']) => {
  try {
    await navigator.clipboard.writeText(text);
    addToast('Copied.', 'success');
  } catch {
    addToast('Could not copy — select it by hand.', 'warning');
  }
};

const DeviceManager: React.FC<{
  devices: PosDevice[];
  isOwner: boolean;
  storeOptions: Array<{ id: string; name: string }>;
  getAccessToken: () => Promise<string | null>;
  addToast: TillOrdersProps['addToast'];
  onChanged: () => void;
}> = ({ devices, isOwner, storeOptions, getAccessToken, addToast, onChanged }) => {
  const [formOpen, setFormOpen] = useState(false);
  const [storeId, setStoreId] = useState(storeOptions[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<FreshPairingCode | null>(null);
  const [ttl, setTtl] = useState(0);
  const [rotated, setRotated] = useState<{ deviceId: string; token: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'rotate'; deviceId: string } | null>(null);

  // TTL countdown for a freshly minted code.
  useEffect(() => {
    if (!fresh) return;
    setTtl(secondsLeft(fresh.expiresAt));
    const t = setInterval(() => setTtl(secondsLeft(fresh.expiresAt)), 1000);
    return () => clearInterval(t);
  }, [fresh]);

  const mint = async () => {
    const store = storeOptions.find((s) => s.id === storeId);
    if (!store || !label.trim()) { addToast('Pick a store and name the till.', 'warning'); return; }
    setBusy(true);
    try {
      const token = (await getAccessToken()) || '';
      const r = await createPairingCode(token, {
        storeId: store.id, storeName: store.name, deviceLabel: label.trim(),
      });
      if (r.status === 'ok') {
        setFresh(r.value);
        setFormOpen(false);
        setLabel('');
      } else if (r.status === 'forbidden') {
        addToast('Only the owner can pair tills.', 'error');
      } else {
        addToast(`Could not create a pairing code (${r.message ?? r.status}).`, 'error');
      }
    } finally { setBusy(false); }
  };

  const doRevoke = async (deviceId: string) => {
    setBusy(true);
    try {
      const token = (await getAccessToken()) || '';
      const r = await revokeDevice(token, deviceId);
      if (r.status === 'ok') {
        addToast('Till revoked — it can no longer upload. Its queued sales stay on the device and upload after a fresh pairing.', 'success');
        onChanged();
      } else {
        addToast(`Could not revoke (${r.message ?? r.status}).`, 'error');
      }
    } finally { setBusy(false); setConfirm(null); }
  };

  const doRotate = async (deviceId: string) => {
    setBusy(true);
    try {
      const token = (await getAccessToken()) || '';
      const r = await rotateDeviceToken(token, deviceId);
      if (r.status === 'ok') {
        setRotated({ deviceId, token: r.value });
      } else {
        addToast(`Could not rotate the token (${r.message ?? r.status}).`, 'error');
      }
    } finally { setBusy(false); setConfirm(null); }
  };

  return (
    <div className="space-y-4">
      {isOwner && (
        <div className="bg-white rounded-2xl border border-[#2E2A26]/10 p-4 space-y-3">
          {!formOpen && !fresh && (
            <button onClick={() => setFormOpen(true)}
              className="px-4 py-2 bg-[#2E2A26] text-white rounded-full text-2xs tracking-wider uppercase font-black flex items-center gap-1 cursor-pointer">
              <Plus size={12} /> Pair a new till
            </button>
          )}
          {formOpen && (
            <div className="space-y-3">
              <div className="grid md:grid-cols-2 gap-3">
                <select value={storeId} onChange={(e) => setStoreId(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-[#2E2A26]/15 text-xs bg-white">
                  {storeOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input value={label} onChange={(e) => setLabel(e.target.value)}
                  placeholder="Till name, e.g. Front counter iPad"
                  className="px-3 py-2 rounded-xl border border-[#2E2A26]/15 text-xs bg-white" />
              </div>
              <div className="flex gap-2">
                <button onClick={() => void mint()} disabled={busy}
                  className="px-4 py-2 bg-[#A46832] text-white rounded-full text-2xs tracking-wider uppercase font-black cursor-pointer disabled:opacity-50">
                  {busy ? 'Creating…' : 'Create pairing code'}
                </button>
                <button onClick={() => setFormOpen(false)}
                  className="px-4 py-2 border border-[#2E2A26]/15 rounded-full text-2xs tracking-wider uppercase font-black cursor-pointer">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {fresh && (
            <div className="rounded-xl border-2 border-[#A46832] bg-amber-50 p-4 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono font-black text-2xl tracking-[0.3em]">{fresh.code}</span>
                <button onClick={() => void copyText(fresh.code, addToast)}
                  className="px-3 py-1.5 bg-white border border-[#2E2A26]/15 rounded-full text-3xs uppercase font-black flex items-center gap-1 cursor-pointer">
                  <Copy size={10} /> Copy
                </button>
              </div>
              <p className="text-2xs text-[#2E2A26]/80 flex items-center gap-1">
                <Clock size={12} />
                {ttl > 0
                  ? <>Expires in <b>{Math.floor(ttl / 60)}:{String(ttl % 60).padStart(2, '0')}</b> · one use · shown ONCE — the database keeps only a hash.</>
                  : <b>Expired — create a fresh code.</b>}
              </p>
              <p className="text-2xs text-[#2E2A26]/70">
                On the till: <b>Staff &amp; settings → Website connection</b> → enter the website address and this code.
              </p>
              <button onClick={() => setFresh(null)}
                className="text-2xs underline cursor-pointer">Done — hide the code</button>
            </div>
          )}
        </div>
      )}

      {devices.length === 0 ? (
        <Empty icon={TabletSmartphone} title="No tills paired"
          body={isOwner
            ? 'Create a pairing code above, then connect the iOS till from Staff & settings → Website connection.'
            : 'The owner can pair tills from this screen.'} />
      ) : (
        <div className="bg-white rounded-2xl border border-[#2E2A26]/10 divide-y divide-[#2E2A26]/8 overflow-hidden">
          {devices.map((d) => (
            <div key={d.id} className={d.revoked ? 'opacity-60' : ''}>
              <div className="px-4 py-3 flex items-center gap-3">
                <TabletSmartphone size={16} className="text-[#2E2A26]/60 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-black text-sm">{d.deviceName} <span className="text-[#2E2A26]/50 font-bold">· {d.deviceCode}</span></div>
                  <div className="text-2xs text-[#2E2A26]/60">{d.storeName} · paired {when(d.pairedAt)}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {d.revoked
                    ? <Badge tone="dark">Revoked</Badge>
                    : d.lastSyncAt
                      ? <Badge tone="green">Synced {when(d.lastSyncAt)}</Badge>
                      : <Badge tone="plain">Never synced</Badge>}
                  {isOwner && !d.revoked && (
                    <>
                      <button title="Rotate token" onClick={() => setConfirm({ kind: 'rotate', deviceId: d.id })}
                        className="p-1.5 rounded-full hover:bg-amber-50 cursor-pointer"><KeyRound size={14} /></button>
                      <button title="Revoke till" onClick={() => setConfirm({ kind: 'revoke', deviceId: d.id })}
                        className="p-1.5 rounded-full hover:bg-red-50 text-[#B4432F] cursor-pointer"><ShieldOff size={14} /></button>
                    </>
                  )}
                </div>
              </div>

              {confirm?.deviceId === d.id && (
                <div className="px-4 pb-3 text-2xs space-y-2 bg-[#FFFDF8]">
                  {confirm.kind === 'revoke' ? (
                    <p>Revoking is <b>immediate</b>: this till gets 401 on its next sync and pauses. Queued sales stay safely on the device and upload after a fresh pairing. Continue?</p>
                  ) : (
                    <p>Rotating issues a <b>new token</b> (shown once). The <b>old token keeps working until the till first uses the new one</b> — enter it on the till under <b>Staff &amp; settings → Website connection → Replace token</b>. Continue?</p>
                  )}
                  <div className="flex gap-2">
                    <button disabled={busy}
                      onClick={() => void (confirm.kind === 'revoke' ? doRevoke(d.id) : doRotate(d.id))}
                      className={`px-3 py-1.5 rounded-full text-3xs uppercase font-black text-white cursor-pointer disabled:opacity-50 ${confirm.kind === 'revoke' ? 'bg-[#B4432F]' : 'bg-[#2E2A26]'}`}>
                      {busy ? 'Working…' : confirm.kind === 'revoke' ? 'Revoke till' : 'Rotate token'}
                    </button>
                    <button onClick={() => setConfirm(null)}
                      className="px-3 py-1.5 rounded-full text-3xs uppercase font-black border border-[#2E2A26]/15 cursor-pointer">Cancel</button>
                  </div>
                </div>
              )}

              {rotated?.deviceId === d.id && (
                <div className="mx-4 mb-3 rounded-xl border-2 border-[#2E2A26] bg-[#FFFDF8] p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-2xs break-all">{rotated.token}</span>
                    <button onClick={() => void copyText(rotated.token, addToast)}
                      className="px-3 py-1.5 bg-white border border-[#2E2A26]/15 rounded-full text-3xs uppercase font-black flex items-center gap-1 cursor-pointer shrink-0">
                      <Copy size={10} /> Copy
                    </button>
                  </div>
                  <p className="text-2xs text-[#2E2A26]/70">
                    Shown <b>once</b> — only a hash is stored. Enter it on the till
                    (<b>Staff &amp; settings → Website connection → Replace token</b>).
                    The old token dies the moment the till first syncs with this one.
                  </p>
                  <button onClick={() => setRotated(null)} className="text-2xs underline cursor-pointer">Done — hide the token</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/* ================================================================== */
/*  WS7 CLIENT ROUND — payment recovery.                               */
/*                                                                     */
/*  Three money-truth surfaces in one place:                           */
/*    1. NEEDS_RECONCILIATION quotes — payments whose fate the 24-hour */
/*       window could not resolve. A manager/owner (MFA) writes the    */
/*       human decision: VOID (no money ever arrived) or RECORD the    */
/*       order (money was taken). resolve_payment_reconciliation().    */
/*    2. Operator-recorded card/online orders awaiting independent     */
/*       settlement evidence. reconcile_card_payment().                */
/*    3. LEGACY held sales — the old submit_web_order outbox, frozen   */
/*       read-only. A manager re-keys each sale through the new till   */
/*       flow, then removes the entry deliberately.                    */
/* ================================================================== */

const EVIDENCE_TYPES = ['terminal_receipt', 'z_report', 'merchant_portal', 'settlement_statement'] as const;
const money = (v: number | string) => `£${Number(v).toFixed(2)}`;

const RecoveryPanel: React.FC<{
  getAccessToken: () => Promise<string | null>;
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
}> = ({ getAccessToken, addToast }) => {
  const deps = useMemo<tp.FlowDeps>(() => ({ getAccessToken }), [getAccessToken]);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'unauthenticated' | 'not_configured' | 'error'>('loading');
  const [quotes, setQuotes] = useState<tp.ReconciliationQuoteRow[]>([]);
  const [cards, setCards] = useState<tp.UnreconciledOrderRow[]>([]);
  const initialLegacy = useMemo(() => legacyOutbox.legacySnapshot(), []);
  const [legacy, setLegacy] = useState<legacyOutbox.OutboxEntry[]>(initialLegacy.entries);
  const [legacyStatus, setLegacyStatus] = useState<legacyOutbox.LegacyOutboxReadStatus>(initialLegacy.status);
  const [openLegacy, setOpenLegacy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [resolveFor, setResolveFor] = useState<string | null>(null);
  const [resolveAction, setResolveAction] = useState<'void' | 'record_order'>('void');
  const [resolveReason, setResolveReason] = useState('');
  /** R4.1: the resolution identity is minted ONCE when the form opens, so a
   *  second click after an ambiguous outcome replays the SAME resolutionId. */
  const [resolveId, setResolveId] = useState('');

  const [reconFor, setReconFor] = useState<string | null>(null);
  const [evType, setEvType] = useState<(typeof EVIDENCE_TYPES)[number]>('terminal_receipt');
  const [evRef, setEvRef] = useState('');
  const [evAmount, setEvAmount] = useState('');
  const [evAt, setEvAt] = useState('');
  const [evReason, setEvReason] = useState('');
  /** R4.1: idempotency key minted once per opened evidence form. */
  const [idemKey, setIdemKey] = useState('');
  /** R4.1/R4.2: an unfinished recovery write held durably on this browser —
   *  read STRICTLY, so an unreadable marker still blocks new recovery writes. */
  const [markerState, setMarkerState] = useState<tp.RecoveryMarkerRead>(() => tp.getRecoveryMarkerState());
  const marker = markerState.status === 'held' ? markerState.marker : null;
  /** R4.3: the recovery screen owns its lease state — never inherited from
   *  the POS. Fail closed while unknown or secondary. */
  const [leaseSt, setLeaseSt] = useState<tillLease.LeaseState>(() => tillLease.leaseState());
  /** R4.4 / F-02: money capability comes from the CORE gate (Web Locks primary
   *  or solo) — never re-derived from the state name, so a heartbeat primary
   *  is read-only here exactly as it is at every RPC. */
  const moneyOk = tillLease.moneyAllowed();
  const leaseStorageOk = tillLease.leaseStorageAvailable();
  const heartbeatPrimary = leaseSt === 'primary' && tillLease.leaseMechanism() === 'heartbeat';
  /** R4.4 / F-01: quotes still INSIDE their payment window — visible, no actions. */
  const [pending, setPending] = useState<tp.PaymentPendingQuoteRow[]>([]);
  const [sweep, setSweep] = useState<tp.SweepOutcome | null>(null);

  const refreshLegacy = () => {
    const snapshot = legacyOutbox.legacySnapshot();
    setLegacy(snapshot.entries);
    setLegacyStatus(snapshot.status);
  };

  const load = async () => {
    setLoadState('loading');
    /* R4.4 / F-01: the sweep is the operational bridge — run it BEFORE the
     * lists so a quote stranded past its window is promoted and appears in
     * the same refresh. Best-effort: a sweep failure never hides the lists. */
    const s = await tp.runRecoverySweep(deps);
    setSweep(s);
    const [q, c, p] = await Promise.all([
      tp.fetchReconciliationQuotes(deps),
      tp.fetchUnreconciledCardOrders(deps),
      tp.fetchPaymentPendingQuotes(deps),
    ]);
    if (q.status !== 'ok') { setLoadState(q.status); return; }
    setQuotes(q.rows);
    setCards(c.status === 'ok' ? c.rows : []);
    setPending(p.status === 'ok' ? p.rows : []);
    refreshLegacy();
    setMarkerState(tp.getRecoveryMarkerState());
    setLoadState('ok');
  };
  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const un = tillLease.subscribeLease(setLeaseSt);
    void tillLease.acquireTillLease().then(setLeaseSt);
    return un;
  }, []);

  const submitResolve = async (q: tp.ReconciliationQuoteRow) => {
    if (resolveReason.trim().length < 10) { addToast(tp.refusalText('reason_required'), 'warning'); return; }
    setBusy(true);
    try {
      const res = await tp.resolveReconciliation(deps, {
        quoteId: q.id, reservationId: q.reservation_id, action: resolveAction,
        reason: resolveReason.trim(), resolutionId: resolveId || tp.newResolutionId(),
      });
      if (res.status === 'ok') {
        addToast(resolveAction === 'void'
          ? 'Quote voided — the record shows no money arrived.'
          : 'Order recorded from the recovered payment.', 'success');
        setResolveFor(null); setResolveReason('');
        await load();
      } else if (res.status === 'refused') addToast(tp.refusalText(res.reason), 'error');
      else if (res.status === 'storage_failed') addToast(tp.STORAGE_FAILED_TEXT, 'error');
      else if (res.status === 'held_recovery_exists') addToast('A different recovery request is already HELD on this browser — it may have already committed. Retry or discard the held write first; nothing was sent.', 'warning');
      else if (res.status === 'lease_blocked') addToast(tp.LEASE_BLOCKED_TEXT, 'error');
      else if (res.status === 'unauthenticated') addToast('Sign in again — resolving needs a manager or owner with MFA.', 'error');
      else addToast('The server did not answer — the exact request is HELD on this browser. Use "Retry held write" to send the same resolution again.', 'warning');
      setMarkerState(tp.getRecoveryMarkerState());
    } finally { setBusy(false); }
  };

  const submitReconcile = async (o: tp.UnreconciledOrderRow) => {
    if (!evRef.trim()) { addToast(tp.refusalText('external_reference_required'), 'warning'); return; }
    if (!evAt) { addToast('Enter when the provider says the payment happened.', 'warning'); return; }
    if (evReason.trim().length < 10) { addToast(tp.refusalText('reason_required'), 'warning'); return; }
    setBusy(true);
    try {
      const res = await tp.reconcileCardPayment(deps, {
        orderId: o.id, evidenceType: evType, externalReference: evRef.trim(), currency: 'GBP',
        matchedAmount: evAmount.trim() || Number(o.total).toFixed(2),
        paymentEventAt: new Date(evAt).toISOString(),
        reason: evReason.trim(), idempotencyKey: idemKey || tp.newIdempotencyKey(),
      });
      if (res.status === 'ok') {
        addToast('Settlement evidence manually matched — recorded against the order.', 'success');
        setReconFor(null); setEvRef(''); setEvAmount(''); setEvAt(''); setEvReason('');
        await load();
      } else if (res.status === 'refused') addToast(tp.refusalText(res.reason), 'error');
      else if (res.status === 'storage_failed') addToast(tp.STORAGE_FAILED_TEXT, 'error');
      else if (res.status === 'held_recovery_exists') addToast('A different recovery request is already HELD on this browser — it may have already committed. Retry or discard the held write first; nothing was sent.', 'warning');
      else if (res.status === 'lease_blocked') addToast(tp.LEASE_BLOCKED_TEXT, 'error');
      else if (res.status === 'unauthenticated') addToast('Sign in again — evidence matching needs a manager or owner with MFA.', 'error');
      else addToast('The server did not answer — the exact request is HELD on this browser. Use "Retry held write" to send the same match again.', 'warning');
      setMarkerState(tp.getRecoveryMarkerState());
    } finally { setBusy(false); }
  };

  /** R4.1: replay the held recovery request byte-for-byte (same resolution
   *  identity / idempotency key), so it can never double-write. */
  const retryMarker = async () => {
    if (!marker) return;
    setBusy(true);
    try {
      const res = marker.kind === 'resolve'
        ? await tp.resolveReconciliation(deps, marker.payload as unknown as tp.ResolutionInput)
        : await tp.reconcileCardPayment(deps, marker.payload as unknown as tp.SettlementInput);
      if (res.status === 'ok') { addToast('The held recovery write is now confirmed.', 'success'); await load(); }
      else if (res.status === 'refused') addToast(tp.refusalText(res.reason), 'error');
      else if (res.status === 'storage_failed') addToast(tp.STORAGE_FAILED_TEXT, 'error');
      else if (res.status === 'held_recovery_exists') addToast('This browser holds a DIFFERENT request than the one being retried — refresh the page and review before continuing.', 'error');
      else if (res.status === 'lease_blocked') addToast(tp.LEASE_BLOCKED_TEXT, 'error');
      else if (res.status === 'unauthenticated') addToast('Sign in again — recovery needs a manager or owner with MFA.', 'error');
      else addToast('Still unreachable — the request stays held for retry.', 'warning');
      setMarkerState(tp.getRecoveryMarkerState());
    } finally { setBusy(false); }
  };

  const markLegacyDone = (id: string) => {
    if (!window.confirm('Remove this held sale from the local queue? Only do this AFTER it has been re-keyed through the till (or ruled not to be a real sale).')) return;
    const removed = legacyOutbox.removeEntry(id);
    refreshLegacy();
    addToast(removed
      ? 'Held sale removed from this browser.'
      : 'The held-sale store could not be safely updated. Download/review the recovery data before retrying.', removed ? 'info' : 'error');
  };

  const downloadLegacyRecovery = () => {
    const raw = legacyOutbox.legacyRecoverySnapshot();
    if (!raw) {
      refreshLegacy();
      addToast('No malformed legacy recovery value is currently available to download.', 'warning');
      return;
    }
    const href = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `milkpop-legacy-held-sales-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
    addToast('Raw legacy recovery data downloaded. Keep it until every sale has been reviewed.', 'info');
  };

  const inputCls = 'w-full px-3 py-2 rounded-xl border border-[#2E2A26]/15 text-xs bg-white';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-2xs text-[#2E2A26]/60 max-w-xl">
          The money-truth surface: stuck payments awaiting a human decision, card
          takings awaiting settlement evidence, and sales held by the previous
          till version. Every action here is written to the permanent record.
        </p>
        <button onClick={() => { void load(); }}
          className="px-4 py-2 bg-white border border-[#2E2A26]/15 rounded-full text-2xs tracking-wider uppercase font-black flex items-center gap-1 cursor-pointer hover:bg-amber-50">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {!leaseStorageOk && (
        <div role="alert" className="rounded-2xl border border-red-400 bg-red-50 px-3 py-2.5">
          <p className="text-2xs font-black text-red-800">
            Browser storage is blocked or unavailable. Recovery decisions are disabled because this tab cannot durably retain the exact request before sending it. Use an approved browser/device with storage enabled.
          </p>
        </div>
      )}
      {leaseStorageOk && !moneyOk && !heartbeatPrimary && (
        <div className="rounded-2xl border border-amber-400 bg-amber-50 px-3 py-2.5 space-y-2">
          <p className="text-2xs font-black text-[#8a5a20]">{tp.LEASE_BLOCKED_TEXT} Recovery writes are disabled on this tab.</p>
          <button onClick={() => { void tillLease.acquireTillLease().then(setLeaseSt); }}
            className="px-4 py-2 rounded-full bg-[#2E2A26] text-white text-3xs font-black uppercase tracking-wider cursor-pointer">Make this tab the till</button>
        </div>
      )}
      {leaseStorageOk && heartbeatPrimary && (
        <div className="rounded-2xl border border-amber-400 bg-amber-50 px-3 py-2.5">
          <p className="text-2xs font-black text-[#8a5a20]">
            This browser lacks Web Locks, so strict till exclusivity cannot be guaranteed — recovery decisions are
            DISABLED on this tab. The lists below stay readable; write decisions from an up-to-date browser or the app.
          </p>
        </div>
      )}
      {sweep && sweep.status === 'ok' && (sweep.movedToReconciliation > 0 || sweep.expired > 0) && (
        <p className="text-[10px] font-bold text-[#3E7A52]">Housekeeping sweep: {sweep.movedToReconciliation} payment{sweep.movedToReconciliation === 1 ? '' : 's'} promoted to a decision, {sweep.expired} open quote{sweep.expired === 1 ? '' : 's'} expired.</p>
      )}
      {sweep && sweep.status === 'error' && (
        <p className="text-[10px] font-bold text-[#A5642B]">Housekeeping sweep failed — a payment past its window may not appear until Refresh succeeds.</p>
      )}
      {markerState.status === 'corrupt' && (
        <div className="rounded-2xl border border-red-400 bg-red-50 px-3 py-2.5 space-y-2">
          <p className="text-2xs font-black text-red-800">
            A held recovery request exists on this browser but is UNREADABLE. New recovery writes are blocked so it
            cannot be overwritten. Review the lists below against the server, then clear it only once accounted for.
          </p>
          <button disabled={busy || !moneyOk} onClick={() => {
            if (!window.confirm('Clear the unreadable held request? The original request may ALREADY HAVE COMMITTED on the server — refresh and re-check the lists before submitting anything new.')) return;
            if (!tp.clearRecoveryMarker()) { addToast('The held request could NOT be provably removed.', 'error'); setMarkerState(tp.getRecoveryMarkerState()); return; }
            setMarkerState({ status: 'missing' });
            addToast('Unreadable held request cleared.', 'info');
          }} className="px-4 py-2 rounded-full border border-red-300 text-3xs font-black uppercase tracking-wider cursor-pointer">Clear after review</button>
        </div>
      )}

      {marker && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-2">
          <p className="text-2xs font-black text-[#8a5a20]">
            An unfinished {marker.kind === 'resolve' ? 'payment resolution' : 'evidence match'} from {new Date(marker.at).toLocaleString()} is held on this browser.
            Retry sends the EXACT same request — same {marker.kind === 'resolve' ? 'resolution id' : 'idempotency key'} — so it can never double-write.
          </p>
          <div className="flex gap-2">
            <button disabled={busy || !moneyOk} onClick={() => { void retryMarker(); }}
              className="px-4 py-2 rounded-full bg-[#2E2A26] text-white text-3xs font-black uppercase tracking-wider cursor-pointer disabled:opacity-50">
              {busy ? 'Sending…' : 'Retry held write'}
            </button>
            <button disabled={busy || !moneyOk} onClick={() => {
              if (!window.confirm('Discard the held write? The original request may ALREADY HAVE COMMITTED on the server — after discarding, refresh and re-check the lists before submitting anything new for the same payment.')) return;
              if (!tp.clearRecoveryMarker()) { addToast('The held request could NOT be provably removed — it may still be present.', 'error'); setMarkerState(tp.getRecoveryMarkerState()); return; }
              setMarkerState({ status: 'missing' });
              addToast('Held request discarded — the underlying payment still shows in the lists if it remains unresolved.', 'info');
            }}
              className="px-4 py-2 rounded-full border border-[#2E2A26]/15 text-3xs font-black uppercase tracking-wider cursor-pointer">Discard</button>
          </div>
        </div>
      )}

      {loadState === 'loading' && <p className="text-2xs text-[#2E2A26]/60">Loading from the cloud…</p>}
      {loadState === 'unauthenticated' && (
        <Empty icon={ShieldOff} title="Sign in again"
          body="Reading the recovery lists needs a signed-in manager or owner." />
      )}
      {loadState === 'not_configured' && (
        <Empty icon={CloudOff} title="No backend configured" body="This environment has no database to reconcile against." />
      )}
      {loadState === 'error' && (
        <Empty icon={CloudOff} title="Could not load" body="The recovery lists could not be fetched — try Refresh." />
      )}

      {loadState === 'ok' && (
        <>
          {/* ---- 1 · payments awaiting a decision ---- */}
          <section className="space-y-2">
            <h3 className="text-2xs uppercase tracking-widest font-black text-[#2E2A26]">Payments awaiting a decision ({quotes.length})</h3>
            {quotes.length === 0 && (
              <p className="text-2xs text-[#2E2A26]/50">None — no payment is stuck past its recovery window.</p>
            )}
            {quotes.map((q) => (
              <div key={q.id} className="bg-white rounded-2xl border border-amber-300 p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-black">{money(q.total)} · {q.channel} · started {when(q.payment_started_at ?? q.created_at)}</span>
                  <span className="text-3xs font-mono text-[#2E2A26]/50">{q.id}</span>
                </div>
                {resolveFor !== q.id ? (
                  <button disabled={busy || !moneyOk || markerState.status !== 'missing'}
                    onClick={() => { setResolveFor(q.id); setResolveAction('void'); setResolveReason(''); setResolveId(tp.newResolutionId()); }}
                    className="px-3 py-1.5 rounded-full bg-[#2E2A26] text-white text-3xs font-black uppercase tracking-wider cursor-pointer disabled:opacity-40">
                    Resolve…
                  </button>
                ) : (
                  <div className="space-y-2 border-t border-[#2E2A26]/10 pt-2">
                    <div className="flex gap-2">
                      <button onClick={() => setResolveAction('void')}
                        className={`flex-1 px-3 py-2 rounded-xl text-3xs font-black uppercase tracking-wider cursor-pointer border ${resolveAction === 'void' ? 'bg-[#C2453E]/10 border-[#C2453E] text-[#A5342E]' : 'bg-white border-[#2E2A26]/15'}`}>
                        Void — no money ever arrived
                      </button>
                      <button onClick={() => setResolveAction('record_order')}
                        className={`flex-1 px-3 py-2 rounded-xl text-3xs font-black uppercase tracking-wider cursor-pointer border ${resolveAction === 'record_order' ? 'bg-[#5FA777]/10 border-[#5FA777] text-[#3E7A52]' : 'bg-white border-[#2E2A26]/15'}`}>
                        Record the order — money WAS taken
                      </button>
                    </div>
                    <input value={resolveReason} onChange={(e) => setResolveReason(e.target.value)}
                      placeholder="Why — what actually happened? (goes in the permanent record)" className={inputCls} />
                    <div className="flex gap-2">
                      <button disabled={busy} onClick={() => { void submitResolve(q); }}
                        className="px-4 py-2 rounded-full bg-[#2E2A26] text-white text-3xs font-black uppercase tracking-wider cursor-pointer disabled:opacity-50">
                        {busy ? 'Writing…' : 'Write the decision'}
                      </button>
                      <button disabled={busy} onClick={() => setResolveFor(null)}
                        className="px-4 py-2 rounded-full border border-[#2E2A26]/15 text-3xs font-black uppercase tracking-wider cursor-pointer">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </section>

          {/* ---- 1b · payments still inside their window (R4.4 / F-01) ---- */}
          <section className="space-y-2">
            <h3 className="text-2xs uppercase tracking-widest font-black text-[#2E2A26]">Payments still inside the recovery window ({pending.length})</h3>
            {pending.length === 0 && (
              <p className="text-2xs text-[#2E2A26]/50">None — nothing is mid-payment right now.</p>
            )}
            {pending.map((q) => (
              <div key={q.id} className="bg-white rounded-2xl border border-[#2E2A26]/10 p-4 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-black">{money(q.total)} · {q.channel} · started {when(q.payment_started_at ?? q.created_at)}</span>
                  <span className="text-3xs font-mono text-[#2E2A26]/50">{q.id}</span>
                </div>
                <p className="text-2xs text-[#2E2A26]/60">
                  Window still open — finalise or release it from the till.
                  {q.payment_started_at
                    ? ` A decision here unlocks ${when(new Date(new Date(q.payment_started_at).getTime() + 24 * 60 * 60 * 1000).toISOString())}.`
                    : ' A decision here unlocks once the 24-hour window closes.'}
                </p>
              </div>
            ))}
          </section>

          {/* ---- 2 · card takings awaiting evidence ---- */}
          <section className="space-y-2">
            <h3 className="text-2xs uppercase tracking-widest font-black text-[#2E2A26]">Card takings awaiting settlement evidence ({cards.length})</h3>
            {cards.length === 0 && (
              <p className="text-2xs text-[#2E2A26]/50">None — every card/online taking has manual settlement evidence recorded.</p>
            )}
            {cards.map((o) => (
              <div key={o.id} className="bg-white rounded-2xl border border-[#2E2A26]/10 p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-black">№ {o.order_number ?? '—'} · {money(o.total)} · {o.payment_method} · {when(o.placed_at)}</span>
                  <span className="text-3xs font-mono text-[#2E2A26]/50">{o.id}</span>
                </div>
                {reconFor !== o.id ? (
                  <button disabled={busy || !moneyOk || markerState.status !== 'missing'}
                    onClick={() => { setReconFor(o.id); setEvType('terminal_receipt'); setEvRef(''); setEvAmount(Number(o.total).toFixed(2)); setEvAt(''); setEvReason(''); setIdemKey(tp.newIdempotencyKey()); }}
                    className="px-3 py-1.5 rounded-full bg-[#2E2A26] text-white text-3xs font-black uppercase tracking-wider cursor-pointer disabled:opacity-40">
                    Match evidence…
                  </button>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-2 border-t border-[#2E2A26]/10 pt-2">
                    <select value={evType} onChange={(e) => setEvType(e.target.value as (typeof EVIDENCE_TYPES)[number])} className={inputCls}>
                      {EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                    </select>
                    <input value={evRef} onChange={(e) => setEvRef(e.target.value)} placeholder="Provider / terminal reference" className={inputCls} />
                    <input value={evAmount} onChange={(e) => setEvAmount(e.target.value)} placeholder="Settled amount" className={inputCls} />
                    <input type="datetime-local" value={evAt} onChange={(e) => setEvAt(e.target.value)} className={inputCls} />
                    <input value={evReason} onChange={(e) => setEvReason(e.target.value)} placeholder="Why this evidence matches (permanent record)" className={`${inputCls} sm:col-span-2`} />
                    <div className="flex gap-2 sm:col-span-2">
                      <button disabled={busy} onClick={() => { void submitReconcile(o); }}
                        className="px-4 py-2 rounded-full bg-[#2E2A26] text-white text-3xs font-black uppercase tracking-wider cursor-pointer disabled:opacity-50">
                        {busy ? 'Writing…' : 'Write the match'}
                      </button>
                      <button disabled={busy} onClick={() => setReconFor(null)}
                        className="px-4 py-2 rounded-full border border-[#2E2A26]/15 text-3xs font-black uppercase tracking-wider cursor-pointer">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </section>

          {/* ---- 3 · legacy held sales ---- */}
          <section className="space-y-2">
            <h3 className="text-2xs uppercase tracking-widest font-black text-[#2E2A26]">Legacy held sales ({legacy.length})</h3>
            <p className="text-2xs text-[#2E2A26]/50 max-w-xl">
              Sales taken on the previous till version, held on THIS browser only. They can
              no longer sync — re-key each one through the till, then remove it here.
            </p>
            {legacyStatus === 'corrupt' && (
              <div role="alert" className="rounded-2xl border border-red-300 bg-red-50 p-4 space-y-2 text-xs text-red-900">
                <p className="font-black">Legacy held-sale data is unreadable — do not clear browser data or retry/remove entries.</p>
                <p>The untouched value is still present. Download it now and keep it for manager-led recovery before changing this browser profile.</p>
                <button type="button" onClick={downloadLegacyRecovery}
                  className="px-3 py-1.5 rounded-full bg-red-800 text-white text-3xs font-black uppercase tracking-wider cursor-pointer inline-flex items-center gap-1">
                  <Download size={10} /> Download raw recovery data
                </button>
              </div>
            )}
            {legacyStatus === 'unavailable' && (
              <div role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950">
                Browser storage is unavailable, so legacy held sales cannot be verified on this device. Do not take or clear payments here until storage access is restored or another approved till device is used.
              </div>
            )}
            {legacyStatus === 'ok' && legacy.length === 0 && <p className="text-2xs text-[#2E2A26]/50">None held on this browser.</p>}
            {legacy.map((e) => (
              <div key={e.id} className="bg-white rounded-2xl border border-amber-300 p-4 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-black">
                    {typeof e.order?.['total'] === 'number' ? money(e.order['total'] as number) : '£—'}
                    {' · '}{String(e.order?.['paymentMethod'] ?? 'unknown method')} · queued {when(e.queuedAt)}
                  </span>
                  <span className="flex gap-1.5">
                    <button onClick={() => setOpenLegacy(openLegacy === e.id ? null : e.id)}
                      className="px-3 py-1.5 rounded-full border border-[#2E2A26]/15 text-3xs font-black uppercase tracking-wider cursor-pointer">
                      {openLegacy === e.id ? 'Hide facts' : 'Show facts'}
                    </button>
                    <button type="button" onClick={() => { void copyText(JSON.stringify(e.row, null, 2), addToast); }}
                      className="px-3 py-1.5 rounded-full border border-[#2E2A26]/15 text-3xs font-black uppercase tracking-wider cursor-pointer flex items-center gap-1">
                      <Copy size={10} /> Copy JSON
                    </button>
                    <button onClick={() => markLegacyDone(e.id)}
                      className="px-3 py-1.5 rounded-full bg-[#C2453E] text-white text-3xs font-black uppercase tracking-wider cursor-pointer">
                      Re-keyed — remove
                    </button>
                  </span>
                </div>
                {openLegacy === e.id && (
                  <pre className="bg-[#2E2A26] text-amber-100 rounded-xl p-3 overflow-x-auto text-3xs leading-relaxed">{JSON.stringify(e.row, null, 2)}</pre>
                )}
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
};
