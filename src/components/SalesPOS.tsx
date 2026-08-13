import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ShoppingCart, Plus, Minus, Trash2, Banknote, CreditCard, Globe2, Percent, Receipt, CheckCircle2, Bike, CloudOff, RefreshCcw, Lock, LockOpen, KeyRound, TimerReset, AlertTriangle, Undo2 } from 'lucide-react';
import {
  MenuItem, Deal, Order, OrderItem, OrderItemModifier, AppliedDeal,
  EmployeeProfile, StoreLocation, SiteSettings, OrderChannel, PaymentMethod, ItemSize,
  VatStatus, TaxCode
} from '../types';
import { LogoIcon } from '../brand';
import { businessTodayISO, isVatCharging, msUntilNextBusinessDay } from '../lib/businessDate';
import { fetchStoreTradingState, fromRow, type StoreTradingState } from '../lib/supabase';
import { getAccessToken as freshStaffToken } from '../lib/auth';
import * as tp from '../lib/tillPayments';
import * as tillLease from '../lib/tillLease';

interface SalesPOSProps {
  employee: EmployeeProfile;
  menuItems: MenuItem[];
  deals: Deal[];
  stores: StoreLocation[];
  orders: Order[];
  /** WS7 client round: the sale lifecycle (quote → reserve → finalise) runs
   *  INSIDE this component through src/lib/tillPayments, with its own durable
   *  attempt store. The parent only receives the server-confirmed order row
   *  to enter into its list. */
  onOrderConfirmed: (order: Order) => void;
  /** FIX-5: sales written locally but not yet confirmed by the database. */
  unsyncedOrders: number;
  /** FIX-5: sales that have failed ≥5 sync attempts and need attention. */
  stuckSalesCount: number;
  /** FIX-5: manual "Sync now" — drains the durable outbox on demand. */
  onSyncOrdersNow: () => void | Promise<void>;
  siteSettings: SiteSettings;
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
}

const CHANNELS: { key: OrderChannel; label: string; icon: React.ReactNode }[] = [
  { key: 'walk_in', label: 'Walk-in', icon: <ShoppingCart className="h-3.5 w-3.5" /> },
  { key: 'phone', label: 'Phone', icon: <Receipt className="h-3.5 w-3.5" /> },
  { key: 'deliveroo', label: 'Deliveroo', icon: <Bike className="h-3.5 w-3.5" /> },
  { key: 'uber_eats', label: 'Uber Eats', icon: <Bike className="h-3.5 w-3.5" /> },
  { key: 'just_eat', label: 'Just Eat', icon: <Bike className="h-3.5 w-3.5" /> },
];

const CATEGORY_LABELS: Record<string, string> = {
  milkshakes: 'Milkshakes', smoothies: 'Smoothies', soft_serve: 'Soft Serve', slush: 'Slush', extras: 'Extras'
};

/* ------------------------------------------------------------------ */
/*  Deal engine — mirrors the calc_order_deals() logic in schema.sql   */
/* ------------------------------------------------------------------ */
export function evaluateDeals(items: OrderItem[], deals: Deal[]): AppliedDeal[] {
  const candidates: AppliedDeal[] = [];
  for (const deal of deals.filter((d) => d.active)) {
    let discount = 0;
    if (deal.type === 'bundle_price' && deal.category && deal.buyQty && deal.bundlePrice != null) {
      // expand qualifying units (base price only, extras stay charged)
      const units = items
        .filter((i) => i.category === deal.category)
        .flatMap((i) => Array(i.quantity).fill(i.unitPrice) as number[])
        .sort((a, b) => b - a);
      const groups = Math.floor(units.length / deal.buyQty);
      for (let g = 0; g < groups; g++) {
        const group = units.slice(g * deal.buyQty, (g + 1) * deal.buyQty);
        const sum = group.reduce((s, p) => s + p, 0);
        if (sum > deal.bundlePrice) discount += sum - deal.bundlePrice;
      }
    }
    if (deal.type === 'buy_x_get_y_free' && deal.category && deal.buyQty && deal.freeQty) {
      const units = items
        .filter((i) => i.category === deal.category)
        .flatMap((i) => Array(i.quantity).fill(i.unitPrice) as number[])
        .sort((a, b) => b - a); // pay for the dearest, free the cheapest
      const per = deal.buyQty + deal.freeQty;
      const groups = Math.floor(units.length / per);
      for (let g = 0; g < groups; g++) {
        const group = units.slice(g * per, (g + 1) * per);
        discount += group.slice(deal.buyQty).reduce((s, p) => s + p, 0);
      }
    }
    if (deal.type === 'percent_off_category' && deal.category && deal.percentOff) {
      const base = items.filter((i) => i.category === deal.category).reduce((s, i) => s + i.unitPrice * i.quantity, 0);
      discount = base * (deal.percentOff / 100);
    }
    if (deal.type === 'fixed_off_order' && deal.amountOff) {
      const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
      if (!deal.minOrderValue || subtotal >= deal.minOrderValue) discount = Math.min(deal.amountOff, subtotal);
    }
    if (discount > 0.004) candidates.push({ dealId: deal.id, dealName: deal.name, discount: Math.round(discount * 100) / 100 });
  }
  // Apply the single best deal for the guest (deals do not stack)
  candidates.sort((a, b) => b.discount - a.discount);
  const best = candidates[0];
  return best ? [best] : [];
}

export const SalesPOS: React.FC<SalesPOSProps> = ({
  employee, menuItems, deals, stores, orders, onOrderConfirmed, unsyncedOrders, stuckSalesCount, onSyncOrdersNow, siteSettings, addToast
}) => {
  const cur = siteSettings.currencySymbol || '£';
  const categories = ['milkshakes', 'smoothies', 'soft_serve', 'slush'] as const;
  const [activeCategory, setActiveCategory] = useState<string>('milkshakes');
  const [cart, setCart] = useState<OrderItem[]>([]);
  const [channel, setChannel] = useState<OrderChannel>('walk_in');
  const [payment, setPayment] = useState<PaymentMethod>('card');
  const [customerName, setCustomerName] = useState('');
  const [cashReceived, setCashReceived] = useState('');
  const [modifierTarget, setModifierTarget] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);

  /* ---------------- WS7 staged payment-flow state ---------------- */
  const tpDeps = useMemo<tp.FlowDeps>(() => ({ getAccessToken: freshStaffToken }), []);
  const [quote, setQuote] = useState<tp.QuoteRow | null>(null);
  const [attempt, setAttempt] = useState<tp.StoredAttempt | null>(null);
  const [providerRef, setProviderRef] = useState('');
  const [pendingList, setPendingList] = useState<tp.StoredAttempt[]>(() => tp.pendingAttempts());
  const [pairedDevice, setPairedDevice] = useState<tp.PairedDevice | null>(() => tp.getPairedDevice());
  const [drawer, setDrawer] = useState<tp.LocalTillSession | null>(() => tp.getLocalTillSession());
  const [pairLabel, setPairLabel] = useState('');
  const [openingFloat, setOpeningFloat] = useState('');
  /** null = hidden; a string = the override-reason prompt is open. */
  const [closeOverride, setCloseOverride] = useState<string | null>(null);
  /** R4.1: an enrol attempt whose outcome never arrived — blocks blind re-pairing. */
  const [custodyMarker, setCustodyMarker] = useState<tp.CustodyMarker | null>(() => tp.getCustodyMarker());
  /** R4.2: one active till tab per browser — this tab's lease role. */
  const [leaseSt, setLeaseSt] = useState<tillLease.LeaseState>(() => tillLease.leaseState());
  const [pairBusy, setPairBusy] = useState(false);
  useEffect(() => {
    const un = tillLease.subscribeLease(setLeaseSt);
    void tillLease.acquireTillLease().then(setLeaseSt);
    /* R4.4 / F-01: fire the housekeeping sweep on POS mount (best-effort,
     * server-authoritative, idempotent) so a quote stranded by a lost
     * browser profile is promoted for the manager without anyone having to
     * open the recovery screen first. */
    void tp.runRecoverySweep(tpDeps);
    return un;
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  /** R4.4 / F-02: money capability comes from the CORE gate (Web Locks primary
   *  or solo) — a heartbeat primary is presence-only and stays read-only. */
  const moneyOk = tillLease.moneyAllowed();
  const leaseStorageOk = tillLease.leaseStorageAvailable();
  const heartbeatPrimary = leaseSt === 'primary' && tillLease.leaseMechanism() === 'heartbeat';
  /** R4.2: fail-closed health of the durable payment store (re-read each render). */
  const storeHealth = tp.attemptsStoreHealth();
  const [quoteSecondsLeft, setQuoteSecondsLeft] = useState(0);
  useEffect(() => tp.subscribeAttempts(() => setPendingList(tp.pendingAttempts())), []);
  /* Quote-expiry countdown. An OPEN quote that dies is silently discarded so
     the cashier can only ever quote a LIVE server price. A RESERVED attempt is
     never timer-discarded — its fate is decided by finalise/release only. */
  useEffect(() => {
    if (!quote || attempt) return;
    const tick = () => {
      const left = Math.floor((new Date(quote.expires_at).getTime() - Date.now()) / 1000);
      setQuoteSecondsLeft(Math.max(left, 0));
      if (left <= 0) {
        setQuote(null);
        addToast('The price quote expired — re-price the basket before taking payment.', 'warning');
      }
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [quote, attempt]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* WS7: the CART is only editable while no payment is reserved. Editing a
     merely-QUOTED basket silently voids the quote (a superseded price must
     never be quoted); editing during a live reservation is refused so money
     and basket can never diverge. */
  const cartLocked = () => {
    if (attempt) {
      addToast('A payment is reserved for this basket — record it or release it before editing.', 'warning');
      return true;
    }
    return false;
  };
  const invalidateQuote = () => {
    if (quote) {
      const staleId = quote.id;
      setQuote(null);
      void (async () => {
        const t = await freshStaffToken().catch(() => null);
        if (t) tp.cancelQuoteBestEffort(staleId, t);
      })();
    }
  };

  const extras = useMemo(() => menuItems.filter((m) => m.category === 'extras'), [menuItems]);
  /* WS6g (Round-9e item 1): while VAT charging is ACTIVE the server refuses
     any unclassified product or extra (product_tax_unclassified). Discovering
     that at submit time means the cashier has already taken the money, so the
     till refuses the item BEFORE it can enter the cart. */
  const needsClassification = (m: { taxCode?: TaxCode | null }) => !m.taxCode;
  /* WS6g (Round-9e item 3): NO FALLBACK. A till that silently borrows
     stores[0] when the employee's store is missing rings sales into the
     WRONG store — wrong VAT configuration, wrong accepted methods, wrong
     ledger. If the employee has no store, or that store has not loaded,
     trading is blocked outright. */
  const store = employee.storeId ? stores.find((s) => s.id === employee.storeId) : undefined;
  const storeMissing = !store;

  const addItem = (item: MenuItem, size: ItemSize) => {
    if (storeCharging && needsClassification(item)) {
      addToast(`"${item.name}" has no VAT classification and cannot be sold — an owner must classify it first.`, 'error');
      return;
    }
    if (cartLocked()) return;
    invalidateQuote();
    const unitPrice = size === 'large' && item.priceLarge != null ? item.priceLarge : item.price;
    setCart((prev) => {
      const match = prev.find((c) => c.menuItemId === item.id && c.size === size && c.modifiers.length === 0);
      if (match) {
        return prev.map((c) => c.id === match.id
          ? { ...c, quantity: c.quantity + 1, lineTotal: round2((unitPrice + modSum(c)) * (c.quantity + 1)) }
          : c);
      }
      const line: OrderItem = {
        id: 'li_' + Date.now() + Math.random().toString(36).slice(2, 6),
        menuItemId: item.id, name: item.name, category: item.category,
        size, unitPrice, quantity: 1, modifiers: [], lineTotal: unitPrice,
      };
      return [...prev, line];
    });
  };

  const modSum = (line: OrderItem) => line.modifiers.reduce((s, m) => s + m.price, 0);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const changeQty = (lineId: string, delta: number) => {
    if (cartLocked()) return;
    invalidateQuote();
    setCart((prev) => prev.flatMap((c) => {
      if (c.id !== lineId) return [c];
      const q = c.quantity + delta;
      if (q <= 0) return [];
      return [{ ...c, quantity: q, lineTotal: round2((c.unitPrice + modSum(c)) * q) }];
    }));
  };

  const toggleModifier = (lineId: string, extra: MenuItem) => {
    // WS6g item 1: an extra is taxed by ITS OWN classification (WS6f), so an
    // unclassified extra fails the sale exactly as an unclassified product
    // does. Refuse it before it can be added, never at payment time.
    if (storeCharging && needsClassification(extra)) {
      addToast(`Extra "${extra.name}" has no VAT classification and cannot be sold — an owner must classify it first.`, 'error');
      return;
    }
    if (cartLocked()) return;
    invalidateQuote();
    setCart((prev) => prev.map((c) => {
      if (c.id !== lineId) return c;
      const has = c.modifiers.find((m) => m.menuItemId === extra.id);
      const modifiers: OrderItemModifier[] = has
        ? c.modifiers.filter((m) => m.menuItemId !== extra.id)
        : [...c.modifiers, { id: 'mod_' + Date.now() + Math.random().toString(36).slice(2, 5), menuItemId: extra.id, name: extra.name, price: extra.price }];
      const unitAll = c.unitPrice + modifiers.reduce((s, m) => s + m.price, 0);
      return { ...c, modifiers, lineTotal: round2(unitAll * c.quantity) };
    }));
  };

  const subtotal = round2(cart.reduce((s, c) => s + c.lineTotal, 0));
  const appliedDeals = useMemo(() => evaluateDeals(cart, deals), [cart, deals]);
  const discountTotal = round2(appliedDeals.reduce((s, d) => s + d.discount, 0));
  const total = round2(Math.max(subtotal - discountTotal, 0));
  /* WS6d (closure brief §1): the browser computes NO tax and falls back to NO
     rate. The store's VAT status drives the display; the SERVER derives every
     stored figure from the store config + tax_codes registry and refuses to
     trade at all if the store's VAT configuration is unconfirmed. Launch
     position is NOT_REGISTERED: tax charged 0, tax amount 0. */
  const storeVat: VatStatus = store?.vatStatus === 'REGISTERED' ? 'REGISTERED' : 'NOT_REGISTERED';
  /* WS6f (audit F1): REGISTERED alone does not charge — the registration's
     EFFECTIVE DATE must have arrived. The till mirrors the server predicate
     exactly so a future-dated registration never implies VAT is being taken.
     Display only: the server remains the sole authority for every figure. */
  const vatEffectiveFrom = store?.vatRegistrationEffectiveDate ?? null;
  /* WS6h (Round-9e finding 3): a till left open across midnight must not keep
     rendering yesterday's VAT answer. `dayTick` forces a re-render just after
     the store's next business-day boundary; the payment handler additionally
     recomputes the predicate FRESH so it can never act on a stale closure. */
  const [dayTick, setDayTick] = useState(0);
  /* WS6i (finding 4): the SERVER's answer, when we can get it. The device
     clock is not an authority — a wrong tablet clock would otherwise let the
     till decide VAT for itself and discover the disagreement only after
     taking money. Refreshed on mount and at each business-day boundary, and
     re-checked immediately before payment while online. */
  const [serverState, setServerState] = useState<StoreTradingState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    let live = true;
    if (!store?.id) { setServerState(null); return () => { live = false; }; }
    void (async () => {
      const token = (await freshStaffToken()) || '';
      const st = token ? await fetchStoreTradingState(store.id, token) : null;
      if (live) setServerState(st);
    })();
    return () => { live = false; };
  }, [store?.id, dayTick]);
  useEffect(() => {
    const t = setTimeout(() => setDayTick((n) => n + 1), msUntilNextBusinessDay(store?.timezone));
    return () => clearTimeout(t);
  }, [dayTick, store?.timezone]);
  // The server wins whenever it has spoken; the local computation is the
  // offline fallback, never an override.
  const storeCharging = useMemo(
    () => (serverState ? serverState.vatChargingNow : isVatCharging(store)),
    [store, dayTick, serverState]);   // eslint-disable-line react-hooks/exhaustive-deps
  const clockDisagrees = !!serverState && serverState.businessDate !== businessTodayISO(store?.timezone);
  /* WS6e: a store still in DRAFT has not completed the owner Setup Wizard —
     the SERVER refuses its sales (store_setup_incomplete); the till mirrors
     that instead of collecting an order that can never submit. Legacy local
     snapshots without the field are not blocked client-side (the server is
     still the gate). The configured payment set, when present, is the ONLY
     set the till offers. */
  /* WS6f (audit F9): FAIL-CLOSED. Trading requires an EXPLICIT ACTIVE setup
     status AND a present payment configuration; a missing/stale local copy is
     treated as not-ready, never as tradable-with-defaults. The server remains
     the real gate — this stops the cashier taking payment for a sale the
     server will refuse. */
  const setupReady = !storeMissing
    && store?.setupStatus === 'ACTIVE'
    && Array.isArray(store.paymentMethods) && store.paymentMethods.length > 0;
  const acceptedPayments: PaymentMethod[] = setupReady ? (store?.paymentMethods ?? []) : [];
  const cash = parseFloat(cashReceived || '0');
  /* WS7: once priced/reserved, the SERVER-quoted total is the only truth money
     may be counted against; the local figure is a pre-quote estimate. */
  const dueTotal = attempt ? parseFloat(attempt.quoteTotal) : (quote ? Number(quote.total) : total);
  const change = cash > dueTotal ? round2(cash - dueTotal) : 0;

  const todaysOrders = useMemo(() => {
    const today = new Date().toDateString();
    return orders.filter((o) => new Date(o.placedAt).toDateString() === today && o.status !== 'voided');
  }, [orders]);
  const todaysRevenue = round2(todaysOrders.filter((o) => o.status !== 'refunded').reduce((s, o) => s + o.total, 0));

  /* FIX-6: a fast double (or triple) tap on a touchscreen used to run
     completeOrder twice, and because every call minted a FRESH id, the
     idempotent write could not collapse them — two distinct sales, double
     charge. This latch swallows every re-entry inside the protection window;
     it is reset on a timer (not a synchronous finally) so the queued tap
     events of the same tick are covered too. */
  const submittingRef = useRef(false);

  /* ---------------- WS7 staged-flow handlers ---------------- */

  /** The WS6-heritage pre-flight guards, run before pricing. */
  const preflight = async (): Promise<boolean> => {
    if (!cart.length) { addToast('The basket is empty — add at least one item.', 'warning'); return false; }
    if (storeMissing) { addToast('This till is not bound to a store — trading is blocked.', 'error'); return false; }
    if (!setupReady) { addToast('Store setup is not active — trading is blocked.', 'error'); return false; }
    const token = (await freshStaffToken().catch(() => null)) || '';
    const fresh = store.id && token ? await fetchStoreTradingState(store.id, token) : null;
    if (fresh) setServerState(fresh);
    const chargingNow = fresh ? fresh.vatChargingNow : isVatCharging(store);
    if (chargingNow) {
      const bad = cart.find((c) => {
        const base = menuItems.find((m) => m.id === c.menuItemId);
        if (!base || needsClassification(base)) return true;
        return c.modifiers.some((mod) => {
          const ex = menuItems.find((m) => m.id === mod.menuItemId);
          return !ex || needsClassification(ex);
        });
      });
      if (bad) { addToast('An item or extra in this cart has no VAT classification — remove it or ask an owner to classify it before taking payment.', 'error'); return false; }
    }
    return true;
  };

  const priceNow = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true);
    try {
      if (!(await preflight())) return;
      const res = await tp.repriceQuote(tpDeps, quote?.id ?? null, {
        channel,
        items: cart.map((c) => ({
          menuItemId: c.menuItemId, size: c.size, quantity: c.quantity, notes: null,
          modifiers: c.modifiers.map((m) => ({ menuItemId: m.menuItemId })),
        })),
        dealIds: appliedDeals.map((d) => d.dealId),
      });
      if (res.status === 'priced') setQuote(res.quote);
      else if (res.status === 'refused') addToast(`Cannot price this basket: ${tp.refusalText(res.reason)}`, 'error');
      else addToast(res.reason === 'auth'
        ? 'Your session has expired — sign in again to price the basket.'
        : res.reason === 'storage'
          ? tp.STORAGE_FAILED_TEXT
          : res.reason === 'lease'
            ? tp.LEASE_BLOCKED_TEXT
            : res.reason === 'corrupt'
              ? tp.CORRUPT_STORE_TEXT
              : 'The server could not be reached — check the connection and try again. No price is locked.', 'error');
    } finally { setSubmitting(false); submittingRef.current = false; }
  };

  const reserveNow = async () => {
    if (submittingRef.current || !quote) return;
    if (!acceptedPayments.includes(payment)) { addToast('That payment method is not enabled for this store.', 'error'); return; }
    let custody: tp.CashCustody | undefined;
    if (payment === 'cash') {
      if (!pairedDevice) { addToast(tp.refusalText('device_not_enrolled'), 'error'); return; }
      if (!drawer) { addToast(tp.refusalText('till_session_not_open'), 'error'); return; }
      custody = { sessionId: drawer.sessionId, deviceId: pairedDevice.deviceId, secret: pairedDevice.secret };
    }
    submittingRef.current = true; setSubmitting(true);
    try {
      const res = await tp.reservePayment(tpDeps, quote, payment as tp.TillMethod, custody);
      if (res.status === 'reserved') { setAttempt(res.attempt); setCashReceived(''); setProviderRef(''); }
      else if (res.status === 'unconfirmed') {
        // R4.1: the server never answered. The attempt is stored at
        // 'reserving' — the panel shows Retry, and NO payment controls.
        setAttempt(res.attempt);
        addToast('The reservation is UNCONFIRMED — do NOT take payment yet. Press "Retry reservation" until the server answers.', 'warning');
      }
      else if (res.status === 'confirmed_unsaved') {
        setAttempt(res.attempt);   // still 'reserving' — payment stays locked
        addToast(tp.CONFIRMED_UNSAVED_TEXT, 'error');
      }
      else if (res.status === 'refused') {
        if (res.reason === 'quote_expired' || res.reason === 'quote_config_stale' || res.reason === 'quote_not_open') setQuote(null);
        addToast(`Payment not reserved: ${tp.refusalText(res.reason)}`, 'error');
      } else if (res.reason === 'lease') {
        addToast(tp.LEASE_BLOCKED_TEXT, 'error');
      } else if (res.reason === 'corrupt') {
        addToast(tp.CORRUPT_STORE_TEXT, 'error');
      } else if (res.reason === 'storage') {
        addToast(tp.STORAGE_FAILED_TEXT, 'error');
      } else if (res.reason === 'auth') {
        addToast('Your session has expired — sign in again, then reserve the payment.', 'error');
      } else {
        addToast('No backend is configured — nothing can be reserved.', 'error');
      }
    } finally { setSubmitting(false); submittingRef.current = false; }
  };

  /** R4.1: replay an UNCONFIRMED reservation with its exact stored identity.
   *  Only a positive server answer promotes it and unlocks payment. */
  const resumeReserveNow = async () => {
    if (submittingRef.current || !attempt) return;
    submittingRef.current = true; setSubmitting(true);
    try {
      const res = await tp.resumeReserve(tpDeps, attempt);
      if (res.status === 'reserved') { setAttempt(res.attempt); addToast('Reservation confirmed — payment may be taken.', 'success'); }
      else if (res.status === 'unconfirmed') addToast('Still unconfirmed — the server has not answered. Do NOT take payment; retry when the connection is back.', 'warning');
      else if (res.status === 'confirmed_unsaved') { setAttempt(res.attempt); addToast(tp.CONFIRMED_UNSAVED_TEXT, 'error'); }
      else if (res.status === 'refused') {
        setAttempt(tp.pendingAttempts().find((a) => a.quoteId === attempt.quoteId) ?? null);
        addToast(`Reservation not confirmed: ${tp.refusalText(res.reason)}`, 'error');
      }
      else if (res.reason === 'auth') addToast('Sign in again, then retry the reservation.', 'error');
      else if (res.reason === 'storage') addToast(tp.STORAGE_FAILED_TEXT, 'error');
      else if (res.reason === 'lease') addToast(tp.LEASE_BLOCKED_TEXT, 'error');
      else if (res.reason === 'corrupt') addToast(tp.CORRUPT_STORE_TEXT, 'error');
      else addToast('No backend is configured.', 'error');
    } finally { setSubmitting(false); submittingRef.current = false; }
  };

  /** Enter the SERVER's order row — the book of record — into the till. */
  const enterConfirmed = (orderRow: tp.OrderRow, paymentStatus: string | undefined, duplicate: boolean) => {
    const saved = fromRow(orderRow) as unknown as Order;
    onOrderConfirmed(saved);
    setLastOrder(saved);
    setCart([]); setCustomerName(''); setCashReceived(''); setProviderRef(''); setModifierTarget(null);
    setQuote(null); setAttempt(null);
    const suffix = paymentStatus === 'OPERATOR_RECORDED_UNRECONCILED' ? ' (card recorded — awaiting manager evidence match)' : '';
    addToast(`Order #${saved.orderNumber ?? '—'} recorded${duplicate ? ' (confirmed from the earlier attempt)' : ''} — ${cur}${(saved.total ?? dueTotal).toFixed(2)}${suffix}.`, 'success');
  };

  const finishFinalise = (res: tp.FinaliseResult) => {
    if (res.status === 'confirmed') { enterConfirmed(res.order, res.paymentStatus, res.duplicate); return; }
    if (res.status === 'storage_failed') {
      // No RPC was made — the browser could not durably record the facts.
      addToast(tp.STORAGE_FAILED_TEXT, 'error');
      return;
    }
    if (res.status === 'store_corrupt') { addToast(tp.CORRUPT_STORE_TEXT, 'error'); return; }
    if (res.status === 'lease_blocked') { addToast(tp.LEASE_BLOCKED_TEXT, 'error'); return; }
    const current = attempt ? tp.pendingAttempts().find((a) => a.quoteId === attempt.quoteId) ?? null : null;
    if (res.status === 'refused') {
      setAttempt(current);
      addToast(`NOT recorded: ${tp.refusalText(res.reason)}`, 'error');
      return;
    }
    setAttempt(current ?? attempt);
    addToast(res.reason === 'auth'
      ? 'Session expired mid-payment. The attempt is SAVED on this till — sign in again and press Retry. Do NOT ring the sale again.'
      : 'The sale may or may not have recorded — the connection dropped. Press Retry to confirm its fate; do NOT ring it again.', 'error');
  };

  const recordCash = async () => {
    if (submittingRef.current || !attempt) return;
    if (!(cash >= dueTotal)) { addToast('Cash received is less than the order total.', 'error'); return; }
    submittingRef.current = true; setSubmitting(true);
    try { finishFinalise(await tp.finaliseCash(tpDeps, attempt, tp.poundsString(cash), customerName || undefined)); }
    finally { setSubmitting(false); submittingRef.current = false; }
  };

  const recordCardOrOnline = async () => {
    if (submittingRef.current || !attempt) return;
    if (!providerRef.trim()) { addToast(tp.refusalText('payment_reference_required'), 'error'); return; }
    submittingRef.current = true; setSubmitting(true);
    try { finishFinalise(await tp.finaliseCardOrOnline(tpDeps, attempt, providerRef.trim(), customerName || undefined)); }
    finally { setSubmitting(false); submittingRef.current = false; }
  };

  const retryConfirm = async () => {
    if (submittingRef.current || !attempt) return;
    submittingRef.current = true; setSubmitting(true);
    try { finishFinalise(await tp.resumeFinalise(tpDeps, attempt)); }
    finally { setSubmitting(false); submittingRef.current = false; }
  };

  const releaseNow = async (outcome: 'declined' | 'abandoned') => {
    if (submittingRef.current || !attempt) return;
    submittingRef.current = true; setSubmitting(true);
    try {
      const res = await tp.releaseAttempt(tpDeps, attempt, outcome);
      if (res.status === 'released') { setAttempt(null); addToast('Payment released — the basket can be edited or re-reserved.', 'info'); }
      else if (res.status === 'already_finalised') {
        addToast('This sale was ALREADY recorded — confirming it now instead of releasing.', 'warning');
        finishFinalise(await tp.resumeFinalise(tpDeps, attempt));
      }
      else if (res.status === 'refused') addToast(`Could not release: ${tp.refusalText(res.reason)}`, 'error');
      else addToast(res.reason === 'auth' ? 'Sign in again to release this payment.'
        : res.reason === 'lease' ? tp.LEASE_BLOCKED_TEXT
        : res.reason === 'corrupt' ? tp.CORRUPT_STORE_TEXT
        : 'Connection unavailable — try releasing again when online.', 'error');
    } finally { setSubmitting(false); submittingRef.current = false; }
  };

  const resumeStored = async (a: tp.StoredAttempt) => {
    if (submittingRef.current) return;
    if (a.stage === 'finalising') {
      submittingRef.current = true; setSubmitting(true);
      try {
        const res = await tp.resumeFinalise(tpDeps, a);
        if (res.status === 'confirmed') { enterConfirmed(res.order, res.paymentStatus, res.duplicate); return; }
        if (res.status === 'refused') { addToast(`Not recorded: ${tp.refusalText(res.reason)}`, 'error'); setPendingList(tp.pendingAttempts()); return; }
        addToast('Still unconfirmed — check the connection and press Resume again.', 'warning');
      } finally { setSubmitting(false); submittingRef.current = false; }
      return;
    }
    // 'reserved' or 'reserving' — adopt into the live panel; the panel's own
    // stage rendering keeps payment controls hidden while unconfirmed.
    setAttempt(a); setPayment(a.method as PaymentMethod); setQuote(null);
    addToast(a.stage === 'reserving'
      ? `Resuming an UNCONFIRMED ${a.method} reservation of ${cur}${a.quoteTotal} — confirm it before taking payment.`
      : `Resuming a reserved ${a.method} payment of ${cur}${a.quoteTotal}.`, 'info');
  };

  const releaseStored = async (a: tp.StoredAttempt) => {
    if (a.stage === 'finalising') { addToast('This attempt may already be recorded — use Resume to confirm its fate first.', 'warning'); return; }
    const res = await tp.releaseAttempt(tpDeps, a, 'abandoned');
    if (res.status === 'released') addToast('Held payment released.', 'info');
    else if (res.status === 'already_finalised') addToast('That sale was already recorded — use Resume to pull it in.', 'warning');
    else if (res.status === 'refused') addToast(`Could not release: ${tp.refusalText(res.reason)}`, 'error');
    else addToast(res.reason === 'lease' ? tp.LEASE_BLOCKED_TEXT
      : res.reason === 'corrupt' ? tp.CORRUPT_STORE_TEXT
      : res.reason === 'auth' ? 'Sign in again to release this payment.'
      : 'Could not reach the server — try again when online.', 'warning');
  };

  /* ---------------- custody handlers ---------------- */
  const pairDevice = async () => {
    if (pairBusy) return;                                    // R4.2: UI half of single-flight
    if (!pairLabel.trim()) { addToast('Give this till device a label first (e.g. "Front counter iPad").', 'warning'); return; }
    setPairBusy(true);
    try {
      const res = await tp.enrolThisDevice(tpDeps, pairLabel.trim());
      if (res.status === 'paired') { setPairedDevice(res.device); setPairLabel(''); setCustodyMarker(tp.getCustodyMarker()); addToast('Device paired. The pairing secret lives ONLY on this browser — clearing site data unpairs it.', 'success'); }
      else if (res.status === 'unknown') {
        setCustodyMarker(tp.getCustodyMarker());
        addToast('Pairing outcome UNKNOWN — a device may have been created without this browser learning its secret. A manager must review the device list (and revoke any orphan) before pairing again. Nothing retries automatically.', 'warning');
      }
      else if (res.status === 'pairing_in_progress') addToast('A pairing attempt is already running — wait for it to finish.', 'warning');
      else if (res.status === 'pairing_review_required') {
        setCustodyMarker(tp.getCustodyMarker());
        addToast('A previous pairing attempt has an UNKNOWN outcome. Review the server device list with a manager, then confirm the review below before pairing again.', 'warning');
      }
      else if (res.status === 'paired_unsaved') {
        addToast(`The server paired this browser (device ${res.deviceId}) but the secret could NOT be stored here — the pairing is unusable. A manager should revoke that device, then pair again on a working browser.`, 'error');
      }
      else if (res.status === 'refused') addToast(tp.refusalText(res.reason), 'error');
      else addToast(res.reason === 'auth' ? 'Pairing needs a signed-in manager or owner with MFA.'
        : res.reason === 'storage' ? tp.STORAGE_FAILED_TEXT
        : res.reason === 'lease' ? tp.LEASE_BLOCKED_TEXT
        : 'No backend is configured.', 'error');
    } finally { setPairBusy(false); }
  };
  /** Audit step 5 + R4.2 #7: local forget only — and only while NO custody is
   *  live (open drawer / pending cash), so the ordinary cash path is never
   *  stranded behind a manager override. */
  const forgetPairing = () => {
    const res = tp.forgetPairedDevice();
    if (res.status === 'forgotten') {
      setPairedDevice(null);
      addToast('Local pairing forgotten on this browser only. The server device still exists — a manager can revoke it from Till orders → Tills, and can pair this browser again here.', 'info');
    } else if (res.status === 'blocked') {
      addToast(res.reason === 'drawer_open'
        ? 'Close the drawer before forgetting the pairing — the secret is needed to close it without a manager override.'
        : res.reason === 'cash_attempt'
          ? 'A cash payment is still held on this till — record or release it before forgetting the pairing.'
          : tp.CORRUPT_STORE_TEXT, 'warning');
    } else {
      addToast('The pairing could NOT be provably removed — this browser may still hold the secret. Involve a manager before treating this device as unpaired.', 'error');
    }
  };
  const openDrawerNow = async () => {
    const res = await tp.openDrawer(tpDeps, openingFloat.trim() || undefined);
    if (res.status === 'open') { setDrawer(tp.getLocalTillSession()); setOpeningFloat(''); setCustodyMarker(tp.getCustodyMarker()); addToast('Drawer open — cash sales enabled.', 'success'); }
    else if (res.status === 'open_unsaved') {
      setDrawer(tp.getLocalTillSession());
      setCustodyMarker(tp.getCustodyMarker());
      addToast('The drawer OPENED ON THE SERVER, but this browser could not save the session. Do NOT take cash — a manager must close or recover the server session (Till orders), then reopen here.', 'error');
    }
    else if (res.status === 'refused') { if (res.reason === 'till_device_revoked' || res.reason === 'device_not_enrolled') setPairedDevice(tp.getPairedDevice()); addToast(tp.refusalText(res.reason), 'error'); }
    else if (res.status === 'unavailable') addToast(res.reason === 'auth' ? 'Sign in again to open the drawer.'
      : res.reason === 'storage' ? tp.STORAGE_FAILED_TEXT
      : res.reason === 'lease' ? tp.LEASE_BLOCKED_TEXT
      : 'Could not reach the server.', 'error');
  };
  const closeDrawerNow = async (override?: string) => {
    if (!drawer) return;
    const res = await tp.closeDrawer(tpDeps, drawer.sessionId, override != null ? { kind: 'override', reason: override } : { kind: 'device' });
    if (res.status === 'closed') { setDrawer(null); setCloseOverride(null); addToast('Drawer closed.', 'success'); }
    else if (res.status === 'closed_unsaved') {
      setDrawer(tp.getLocalTillSession());
      setCloseOverride(null);
      addToast('The server closed the drawer, but this browser could not remove its local record — the display may still show it open. Refresh the page; if it persists, involve a manager before using this till.', 'warning');
    }
    else if (res.status === 'refused') {
      if (res.reason === 'unknown_session') setDrawer(tp.getLocalTillSession());
      if ((res.reason === 'device_credential_invalid' || res.reason === 'till_device_revoked') && override == null) setCloseOverride('');
      addToast(tp.refusalText(res.reason), 'error');
    }
    else if (res.status === 'unavailable') addToast(res.reason === 'auth' ? 'Sign in again to close the drawer.'
      : res.reason === 'storage' ? tp.STORAGE_FAILED_TEXT
      : res.reason === 'lease' ? tp.LEASE_BLOCKED_TEXT
      : 'Could not reach the server.', 'error');
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start text-left">
      {/* ------------------------------ item picker ------------------------------ */}
      <div className="xl:col-span-7 space-y-5">
        <div className="bg-white rounded-3xl border border-[#EBDECE] p-5 sm:p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="font-display text-lg font-bold text-[#2E2A26]">Till — New Sale</h2>
              <p className="text-2xs text-[#2E2A26]/60 font-light">{store?.name} · served by {employee.name}</p>
            </div>
            <div className="text-right">
              <p className="text-2xs uppercase tracking-widest text-[#A46832] font-bold">Today</p>
              <p className="text-sm font-bold text-[#2E2A26]">{todaysOrders.length} orders · {cur}{todaysRevenue.toFixed(2)}</p>
            </div>
          </div>

          {/* WS7: the durable outbox is LEGACY-ONLY. submit_web_order() no
              longer exists, so these entries can never sync — they are shown
              so held money-bearing rows stay visible until a manager re-keys
              them through the new flow (Till orders → legacy held sales). */}
          {unsyncedOrders > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4 px-3 py-2 rounded-2xl border border-amber-300 bg-amber-50">
              <p className="flex items-center gap-1.5 text-2xs font-bold text-[#8a5a20]">
                <CloudOff className="h-3.5 w-3.5" />
                {unsyncedOrders} sale{unsyncedOrders === 1 ? '' : 's'} from the previous till version held locally
                {stuckSalesCount > 0 && (
                  <span className="text-red-700"> · will not sync automatically — a manager can re-key them from Till orders</span>
                )}
              </p>
              <button onClick={() => { void onSyncOrdersNow(); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-amber-400 text-[10px] font-black uppercase tracking-wider text-[#8a5a20] hover:bg-amber-100 cursor-pointer">
                <AlertTriangle className="h-3 w-3" /> What is this?
              </button>
            </div>
          )}

          <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1 mb-4">
            {categories.map((c) => (
              <button key={c} onClick={() => setActiveCategory(c)}
                className={`px-4 py-2 rounded-full text-2xs uppercase tracking-wider font-bold whitespace-nowrap transition-all cursor-pointer ${activeCategory === c ? 'bg-[#A46832] text-white' : 'bg-[#F7EFE6] text-[#2E2A26] hover:bg-[#EBDECE]'}`}>
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {menuItems.filter((m) => m.category === activeCategory).map((item) => (
              <div key={item.id} className="rounded-2xl border border-[#EBDECE] p-3 hover:border-[#A46832]/60 transition-colors bg-white flex flex-col justify-between">
                <div>
                  <p className="text-xs font-bold text-[#2E2A26] leading-snug">{item.name}</p>
                  <p className="text-[10px] text-[#2E2A26]/55 font-light mt-0.5">
                    {cur}{item.price.toFixed(2)}{item.priceLarge != null ? ` / ${cur}${item.priceLarge.toFixed(2)}` : ''}
                  </p>
                  {storeCharging && needsClassification(item) && (
                    <p className="mt-1 text-[9px] font-black uppercase tracking-wide text-[#A5642B]">Not sellable — no VAT class</p>
                  )}
                </div>
                <div className="flex gap-1.5 mt-3">
                  {item.priceLarge != null ? (
                    <>
                      <button onClick={() => addItem(item, 'regular')} disabled={storeCharging && needsClassification(item)} className="disabled:opacity-40 disabled:cursor-not-allowed flex-1 py-1.5 rounded-lg bg-[#F7EFE6] hover:bg-[#A46832] hover:text-white text-2xs font-bold transition-colors cursor-pointer">Reg</button>
                      <button onClick={() => addItem(item, 'large')} disabled={storeCharging && needsClassification(item)} className="disabled:opacity-40 disabled:cursor-not-allowed flex-1 py-1.5 rounded-lg bg-[#F7EFE6] hover:bg-[#A46832] hover:text-white text-2xs font-bold transition-colors cursor-pointer">Lrg</button>
                    </>
                  ) : (
                    <button onClick={() => addItem(item, 'one_size')} disabled={storeCharging && needsClassification(item)} className="disabled:opacity-40 disabled:cursor-not-allowed flex-1 py-1.5 rounded-lg bg-[#F7EFE6] hover:bg-[#A46832] hover:text-white text-2xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1"><Plus className="h-3 w-3" /> Add</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Active deals reference card */}
        <div className="bg-[#7CC0C7]/15 border border-[#7CC0C7]/50 rounded-3xl p-5">
          <h3 className="text-2xs uppercase tracking-widest font-black text-[#2E2A26] flex items-center gap-2"><Percent className="h-3.5 w-3.5 text-[#A46832]" /> Live combos — best one applies automatically</h3>
          <div className="flex flex-wrap gap-2 mt-3">
            {deals.filter((d) => d.active).map((d) => (
              <span key={d.id} className="px-3 py-1.5 bg-white rounded-full text-2xs font-bold text-[#2E2A26] border border-[#7CC0C7]/60">
                <span className="text-[#A46832] mr-1.5">{d.badge || '%'}</span>{d.name}
              </span>
            ))}
            {deals.filter((d) => d.active).length === 0 && (
              <span className="text-2xs text-[#2E2A26]/60 font-light">No active combos. The owner can add them in Admin Panel → Deals & Combos.</span>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------ basket ------------------------------ */}
      <div className="xl:col-span-5 bg-white rounded-3xl border border-[#EBDECE] shadow-sm p-5 sm:p-6 space-y-4 xl:sticky xl:top-24">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-[#2E2A26] flex items-center gap-2"><ShoppingCart className="h-4 w-4 text-[#A46832]" /> Basket</h2>
          {cart.length > 0 && (
            <button onClick={() => { if (cartLocked()) return; invalidateQuote(); setCart([]); }} className="text-2xs text-red-500 font-bold uppercase tracking-wider hover:underline cursor-pointer">Clear</button>
          )}
        </div>

        {/* ---------------- WS7 drawer & device custody strip ---------------- */}
        <div className="rounded-2xl border border-[#EBDECE] bg-[#F7EFE6]/50 px-3 py-2.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-2xs font-bold text-[#2E2A26]">
              <KeyRound className="h-3.5 w-3.5 text-[#A46832]" />
              {pairedDevice ? `Till device: ${pairedDevice.label}` : 'Not paired as a till device'}
            </p>
            {pairedDevice ? (
              drawer ? (
                <span className="flex items-center gap-1.5 text-2xs font-bold text-[#3E7A52]"><LockOpen className="h-3.5 w-3.5" /> Drawer open</span>
              ) : (
                <span className="flex items-center gap-1.5 text-2xs font-bold text-[#8a5a20]"><Lock className="h-3.5 w-3.5" /> Drawer closed</span>
              )
            ) : null}
          </div>
          {!pairedDevice && custodyMarker?.kind === 'enrol' && custodyMarker.outcome === 'unknown' && (
            <p className="text-[10px] font-bold text-[#A5642B]">
              A previous pairing attempt had an UNKNOWN outcome ({new Date(custodyMarker.at).toLocaleTimeString()}). Pairing stays locked until a manager reviews the server device list for an orphan.
              {' '}<button onClick={() => {
                if (window.confirm('Confirm: a manager has reviewed the server device list (Till orders → Tills) and revoked any orphaned device from that attempt. Clear the review lock?')) {
                  if (tp.clearCustodyMarker()) setCustodyMarker(null);
                  else addToast('The review lock could NOT be provably removed — it may still be present. Pairing stays locked; involve a manager before retrying.', 'error');
                }
              }} className="underline cursor-pointer">I reviewed the device list — clear</button>
            </p>
          )}
          {!pairedDevice && !(custodyMarker?.kind === 'enrol' && custodyMarker.outcome === 'unknown') && (
            <div className="flex gap-2">
              <input value={pairLabel} onChange={(e) => setPairLabel(e.target.value)} placeholder="Device label (manager + MFA to pair)"
                className="flex-1 bg-white border border-[#EBDECE] rounded-xl px-3 py-2 text-2xs outline-none focus:border-[#A46832]" />
              <button onClick={() => { void pairDevice(); }} disabled={pairBusy} className="px-3 py-2 rounded-xl bg-[#2E2A26] text-white text-2xs font-bold cursor-pointer disabled:opacity-50">{pairBusy ? 'Pairing…' : 'Pair'}</button>
            </div>
          )}
          {pairedDevice && !drawer && (
            <button onClick={forgetPairing}
              className="w-full py-1.5 rounded-xl border border-dashed border-[#EBDECE] text-[10px] font-bold text-[#2E2A26]/50 hover:text-[#A5642B] hover:border-[#A5642B]/40 cursor-pointer">
              Forget pairing (this browser only — the server device stays until a manager revokes it)
            </button>
          )}
          {pairedDevice && !drawer && (
            <div className="flex gap-2">
              <input type="number" min="0" step="0.01" value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} placeholder={`Opening float (${cur}, optional)`}
                className="flex-1 bg-white border border-[#EBDECE] rounded-xl px-3 py-2 text-2xs outline-none focus:border-[#A46832]" />
              <button onClick={() => { void openDrawerNow(); }} className="px-3 py-2 rounded-xl bg-[#5FA777] text-white text-2xs font-bold cursor-pointer">Open drawer</button>
            </div>
          )}
          {pairedDevice && drawer && closeOverride == null && (
            <button onClick={() => { void closeDrawerNow(); }} className="w-full py-2 rounded-xl border border-[#EBDECE] bg-white hover:bg-[#EBDECE] text-2xs font-bold cursor-pointer">Close drawer (count the cash first)</button>
          )}
          {closeOverride != null && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold text-[#A5642B]">Manager/owner override (MFA session) — write why the device secret can't be used:</p>
              <div className="flex gap-2">
                <input value={closeOverride} onChange={(e) => setCloseOverride(e.target.value)} placeholder="Reason (min 10 characters)"
                  className="flex-1 bg-white border border-[#EBDECE] rounded-xl px-3 py-2 text-2xs outline-none focus:border-[#A46832]" />
                <button onClick={() => { void closeDrawerNow(closeOverride); }} className="px-3 py-2 rounded-xl bg-[#2E2A26] text-white text-2xs font-bold cursor-pointer">Close</button>
                <button onClick={() => setCloseOverride(null)} className="px-3 py-2 rounded-xl border border-[#EBDECE] text-2xs font-bold cursor-pointer">Cancel</button>
              </div>
            </div>
          )}
        </div>

        {/* ---------- payments saved on this till, awaiting an outcome ---------- */}
        {pendingList.filter((a) => a.quoteId !== attempt?.quoteId).length > 0 && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-2">
            <p className="flex items-center gap-1.5 text-2xs font-black text-[#8a5a20]"><AlertTriangle className="h-3.5 w-3.5" /> Payments held on this till</p>
            {pendingList.filter((a) => a.quoteId !== attempt?.quoteId).map((a) => (
              <div key={a.quoteId} className="flex flex-wrap items-center justify-between gap-2 text-2xs">
                <span className="font-bold text-[#2E2A26]">{cur}{a.quoteTotal} · {a.method} · {a.stage === 'finalising' ? 'confirming' : a.stage === 'reserving' ? 'UNCONFIRMED reservation' : 'reserved'} · {new Date(a.createdAt).toLocaleTimeString()}</span>
                <span className="flex gap-1.5">
                  <button onClick={() => { void resumeStored(a); }} className="px-2.5 py-1 rounded-full bg-[#A46832] text-white text-[10px] font-black uppercase tracking-wider cursor-pointer">Resume</button>
                  {tp.attemptCapabilities(a).canRelease && (
                    <button onClick={() => { void releaseStored(a); }} className="px-2.5 py-1 rounded-full border border-[#EBDECE] text-[10px] font-black uppercase tracking-wider cursor-pointer">Release</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {cart.length === 0 && !lastOrder && (
          <div className="py-10 text-center">
            <LogoIcon className="h-12 w-auto mx-auto opacity-25" />
            <p className="text-2xs text-[#2E2A26]/50 font-light mt-3">Tap an item to start a new order.</p>
          </div>
        )}

        {cart.length === 0 && lastOrder && (
          <div className="py-6 text-center bg-[#F7EFE6] rounded-2xl border border-[#EBDECE]">
            <CheckCircle2 className="h-7 w-7 text-[#5FA777] mx-auto" />
            <p className="text-xs font-bold text-[#2E2A26] mt-2">Order #{lastOrder.orderNumber} complete</p>
            <p className="text-2xs text-[#2E2A26]/60 font-light">
              {cur}{lastOrder.total.toFixed(2)} · {lastOrder.paymentMethod}{lastOrder.changeGiven ? ` · change ${cur}${lastOrder.changeGiven.toFixed(2)}` : ''}
            </p>
          </div>
        )}

        {cart.map((line) => (
          <div key={line.id} className="border border-[#EBDECE] rounded-2xl p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-bold text-[#2E2A26]">{line.name}
                  {line.size !== 'one_size' && <span className="ml-1.5 text-[10px] uppercase text-[#A46832]">{line.size}</span>}
                </p>
                {line.modifiers.length > 0 && (
                  <p className="text-[10px] text-[#2E2A26]/60 font-light">+ {line.modifiers.map((m) => m.name).join(', ')}</p>
                )}
              </div>
              <p className="text-xs font-bold text-[#2E2A26] whitespace-nowrap">{cur}{line.lineTotal.toFixed(2)}</p>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <button onClick={() => changeQty(line.id, -1)} className="h-7 w-7 rounded-full bg-[#F7EFE6] hover:bg-[#EBDECE] flex items-center justify-center cursor-pointer"><Minus className="h-3 w-3" /></button>
                <span className="w-6 text-center text-xs font-bold">{line.quantity}</span>
                <button onClick={() => changeQty(line.id, 1)} className="h-7 w-7 rounded-full bg-[#F7EFE6] hover:bg-[#EBDECE] flex items-center justify-center cursor-pointer"><Plus className="h-3 w-3" /></button>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setModifierTarget(modifierTarget === line.id ? null : line.id)}
                  className={`text-2xs font-bold uppercase tracking-wider cursor-pointer ${modifierTarget === line.id ? 'text-[#A46832]' : 'text-[#2E2A26]/60 hover:text-[#A46832]'}`}>
                  Extras
                </button>
                <button onClick={() => { if (cartLocked()) return; invalidateQuote(); setCart((p) => p.filter((c) => c.id !== line.id)); }} className="text-red-400 hover:text-red-600 cursor-pointer"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            {modifierTarget === line.id && (
              <div className="flex flex-wrap gap-1.5 pt-2 border-t border-[#EBDECE]">
                {extras.map((ex) => {
                  const on = !!line.modifiers.find((m) => m.menuItemId === ex.id);
                  return (
                    <button key={ex.id} onClick={() => toggleModifier(line.id, ex)}
                      disabled={storeCharging && needsClassification(ex) && !on}
                      title={storeCharging && needsClassification(ex) ? 'No VAT classification — not sellable' : undefined}
                      className={`px-2.5 py-1 rounded-full text-[10px] font-bold cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${on ? 'bg-[#A46832] text-white' : 'bg-[#F7EFE6] text-[#2E2A26] hover:bg-[#EBDECE]'}`}>
                      {ex.name} +{cur}{ex.price.toFixed(2)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {(cart.length > 0 || attempt) && (
          <>
            {/* channel + payment + customer */}
            <div className="space-y-3 pt-2">
              <div className="flex flex-wrap gap-1.5">
                {CHANNELS.map((c) => (
                  <button key={c.key} disabled={!!attempt} onClick={() => { if (cartLocked()) return; invalidateQuote(); setChannel(c.key); }}
                    className={`px-3 py-1.5 rounded-full text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${channel === c.key ? 'bg-[#2E2A26] text-white' : 'bg-[#F7EFE6] text-[#2E2A26] hover:bg-[#EBDECE]'}`}>
                    {c.icon}{c.label}
                  </button>
                ))}
              </div>
              <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Customer name for the cup (optional)"
                className="w-full bg-[#F7EFE6]/60 border border-[#EBDECE] rounded-xl px-3 py-2.5 text-xs outline-none focus:border-[#A46832]" />
              <div className="grid grid-cols-3 gap-1.5">
                {([['card', 'Card', <CreditCard key="c" className="h-3.5 w-3.5" />], ['cash', 'Cash', <Banknote key="b" className="h-3.5 w-3.5" />], ['online', 'Online', <Globe2 key="o" className="h-3.5 w-3.5" />]] as [PaymentMethod, string, React.ReactNode][]).filter(([key]) => acceptedPayments.includes(key)).map(([key, label, icon]) => (
                  <button key={key} disabled={!!attempt || (key === 'cash' && !drawer)}
                    title={key === 'cash' && !drawer ? 'Open the till drawer to take cash' : undefined}
                    onClick={() => setPayment(key)}
                    className={`py-2 rounded-xl text-2xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${payment === key ? 'bg-[#7CC0C7] text-[#2E2A26]' : 'bg-[#F7EFE6] text-[#2E2A26]/70 hover:bg-[#EBDECE]'}`}>
                    {icon}{label}
                  </button>
                ))}
              </div>
            </div>

            {/* totals */}
            <div className="border-t border-[#EBDECE] pt-3 space-y-1.5 text-xs">
              <div className="flex justify-between text-[#2E2A26]/70 font-light"><span>Subtotal</span><span>{cur}{subtotal.toFixed(2)}</span></div>
              {appliedDeals.map((d) => (
                <div key={d.dealId} className="flex justify-between text-[#5FA777] font-bold"><span>{d.dealName}</span><span>−{cur}{d.discount.toFixed(2)}</span></div>
              ))}
              {storeCharging ? (
                <div className="flex justify-between text-[#2E2A26]/60 font-light"><span>VAT (included)</span><span>itemised on receipt</span></div>
              ) : storeVat === 'REGISTERED' ? (
                <div className="flex justify-between text-[#2E2A26]/60 font-light"><span>No VAT charged yet — registration effective {vatEffectiveFrom ?? '—'}</span><span>{cur}0.00</span></div>
              ) : (
                <div className="flex justify-between text-[#2E2A26]/60 font-light"><span>No VAT charged — not VAT registered</span><span>{cur}0.00</span></div>
              )}
              <div className="flex justify-between text-base font-black text-[#2E2A26] pt-1">
                <span>{quote || attempt ? 'Total (server-quoted)' : 'Total (estimate)'}</span>
                <span>{cur}{dueTotal.toFixed(2)}</span>
              </div>
              {store?.receiptFooter ? (
                <p className="pt-1.5 text-[10px] text-[#2E2A26]/50 font-light leading-snug border-t border-[#EBDECE]/60">{store.receiptFooter}</p>
              ) : null}
            </div>

            {!navigator.onLine && (
              <div className="rounded-xl border border-[#C2453E]/40 bg-[#C2453E]/10 px-3 py-2.5 text-2xs font-black text-[#A5342E]">
                Connection unavailable — DO NOT accept payment. A sale is only real once the server confirms it; reconnect and try again.
              </div>
            )}
            {clockDisagrees && (
              <div className="rounded-xl border border-[#A46832]/40 bg-[#A46832]/10 px-3 py-2.5 text-2xs font-bold text-[#A5642B]">
                This device's date differs from the server's business date ({serverState?.businessDate}). The server's answer is being used; please have the tablet clock corrected.
              </div>
            )}
            {!setupReady && (
              <div className="rounded-xl border border-[#A46832]/40 bg-[#A46832]/10 px-3 py-2.5 text-2xs font-bold text-[#A5642B]">
                {storeMissing
                  ? 'This till is not bound to a store. Your staff record has no store, or its configuration has not loaded — trading is blocked (a sale must never be rung into another store).'
                  : "Store configuration not active or not loaded — trading is blocked until the owner's Store Setup is ACTIVE and synced to this till."}
              </div>
            )}
            {/* ---------------- WS7 staged action panel ---------------- */}
            {!leaseStorageOk && (
              <div role="alert" className="rounded-2xl border border-red-400 bg-red-50 p-3">
                <p className="text-2xs font-black text-red-800">
                  Browser storage is blocked or unavailable — taking payment is DISABLED because this till cannot durably retain recovery facts. Use an approved browser/device with storage enabled.
                </p>
              </div>
            )}
            {leaseStorageOk && !moneyOk && !heartbeatPrimary && (
              <div className="space-y-2 rounded-2xl border border-amber-400 bg-amber-50 p-3">
                <p className="text-2xs font-black text-[#8a5a20]">{tp.LEASE_BLOCKED_TEXT}</p>
                <button onClick={() => { void tillLease.acquireTillLease().then(setLeaseSt); }}
                  className="w-full py-2 rounded-xl bg-[#2E2A26] text-white text-2xs font-bold cursor-pointer">Make this tab the till</button>
              </div>
            )}
            {leaseStorageOk && heartbeatPrimary && (
              <div className="rounded-2xl border border-amber-400 bg-amber-50 p-3">
                <p className="text-2xs font-black text-[#8a5a20]">
                  This browser lacks Web Locks, so strict till exclusivity cannot be guaranteed — taking money is
                  DISABLED on this tab (browsing stays available). Use an up-to-date browser or the Milk Pop app to trade.
                </p>
              </div>
            )}
            {moneyOk && storeHealth === 'corrupt' && (
              <div className="rounded-2xl border border-red-400 bg-red-50 p-3">
                <p className="text-2xs font-black text-red-800">{tp.CORRUPT_STORE_TEXT}</p>
              </div>
            )}
            {moneyOk && storeHealth === 'ok' && (<>
            {!attempt && !quote && (
              <button onClick={() => { void priceNow(); }} disabled={!cart.length || !setupReady || submitting}
                className="w-full py-4 bg-[#A46832] hover:bg-[#A5642B] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-2xl text-xs uppercase tracking-widest font-black transition-colors cursor-pointer shadow-md">
                {submitting ? 'Pricing with server…' : `Price basket — est. ${cur}${total.toFixed(2)}`}
              </button>
            )}
            {!attempt && quote && (
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-xl border border-[#7CC0C7]/60 bg-[#7CC0C7]/10 px-3 py-2 text-2xs font-bold text-[#2E2A26]">
                  <span className="flex items-center gap-1.5"><TimerReset className="h-3.5 w-3.5 text-[#A46832]" /> Server price locked</span>
                  <span>{Math.floor(quoteSecondsLeft / 60)}:{String(quoteSecondsLeft % 60).padStart(2, '0')} left</span>
                </div>
                <button onClick={() => { void reserveNow(); }} disabled={submitting}
                  className="w-full py-4 bg-[#2E2A26] hover:bg-black disabled:opacity-50 text-white rounded-2xl text-xs uppercase tracking-widest font-black transition-colors cursor-pointer shadow-md">
                  {submitting ? 'Reserving…' : `Reserve ${payment} payment — ${cur}${dueTotal.toFixed(2)}`}
                </button>
                <button onClick={() => { void priceNow(); }} disabled={submitting}
                  className="w-full py-2 rounded-xl border border-[#EBDECE] text-2xs font-bold text-[#2E2A26]/70 hover:bg-[#F7EFE6] cursor-pointer">Re-price</button>
              </div>
            )}
            {attempt && tp.attemptCapabilities(attempt).canResumeReserve && (
              <div className="space-y-2 rounded-2xl border border-amber-400 bg-amber-50 p-3">
                <p className="text-2xs font-black text-[#8a5a20]">Reservation UNCONFIRMED for this {attempt.method} payment of {cur}{attempt.quoteTotal}. Do NOT take payment until the server confirms.</p>
                <button onClick={() => { void resumeReserveNow(); }} disabled={submitting}
                  className="w-full py-3.5 bg-[#A46832] hover:bg-[#A5642B] disabled:opacity-50 text-white rounded-2xl text-xs uppercase tracking-widest font-black cursor-pointer flex items-center justify-center gap-1.5">
                  <RefreshCcw className="h-3.5 w-3.5" /> {submitting ? 'Confirming…' : 'Retry reservation'}
                </button>
                <button onClick={() => { void releaseNow('abandoned'); }} disabled={submitting}
                  className="w-full py-2 rounded-xl border border-[#EBDECE] bg-white text-2xs font-bold text-[#2E2A26]/70 hover:bg-[#F7EFE6] cursor-pointer flex items-center justify-center gap-1.5">
                  <Undo2 className="h-3.5 w-3.5" /> Cancel this attempt
                </button>
              </div>
            )}
            {attempt && tp.attemptCapabilities(attempt).canTakePayment && (
              <div className="space-y-2 rounded-2xl border border-[#A46832]/50 bg-[#A46832]/5 p-3">
                <p className="text-2xs font-black uppercase tracking-wider text-[#A5642B]">Take {attempt.method} payment — {cur}{attempt.quoteTotal}</p>
                {attempt.method === 'cash' ? (
                  <>
                    <div className="flex items-center gap-2">
                      <input type="number" min="0" step="0.01" value={cashReceived} onChange={(e) => setCashReceived(e.target.value)} placeholder={`Cash received (${cur})`}
                        className="flex-1 bg-white border border-[#EBDECE] rounded-xl px-3 py-2.5 text-xs outline-none focus:border-[#A46832]" />
                      <span className="text-2xs font-bold text-[#2E2A26] whitespace-nowrap">Change: {cur}{change.toFixed(2)}</span>
                    </div>
                    <button onClick={() => { void recordCash(); }} disabled={submitting}
                      className="w-full py-3.5 bg-[#5FA777] hover:bg-[#3E7A52] disabled:opacity-50 text-white rounded-2xl text-xs uppercase tracking-widest font-black cursor-pointer">
                      {submitting ? 'Recording…' : 'Record cash taken'}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-2xs text-[#2E2A26]/70 font-light">Charge {cur}{attempt.quoteTotal} on the terminal, then enter the receipt reference.</p>
                    <input value={providerRef} onChange={(e) => setProviderRef(e.target.value)} placeholder="Terminal / provider reference"
                      className="w-full bg-white border border-[#EBDECE] rounded-xl px-3 py-2.5 text-xs outline-none focus:border-[#A46832]" />
                    <button onClick={() => { void recordCardOrOnline(); }} disabled={submitting}
                      className="w-full py-3.5 bg-[#5FA777] hover:bg-[#3E7A52] disabled:opacity-50 text-white rounded-2xl text-xs uppercase tracking-widest font-black cursor-pointer">
                      {submitting ? 'Recording…' : `Record ${attempt.method} payment`}
                    </button>
                  </>
                )}
                <button onClick={() => { void releaseNow(attempt.method === 'cash' ? 'abandoned' : 'declined'); }} disabled={submitting}
                  className="w-full py-2 rounded-xl border border-[#EBDECE] bg-white text-2xs font-bold text-[#2E2A26]/70 hover:bg-[#F7EFE6] cursor-pointer flex items-center justify-center gap-1.5">
                  <Undo2 className="h-3.5 w-3.5" /> {attempt.method === 'cash' ? 'Customer left — release' : 'Declined / customer left — release'}
                </button>
              </div>
            )}
            {attempt && attempt.stage === 'finalising' && (
              <div className="space-y-2 rounded-2xl border border-amber-400 bg-amber-50 p-3">
                <p className="text-2xs font-black text-[#8a5a20]">This {attempt.method} sale of {cur}{attempt.quoteTotal} may already be recorded. Do NOT ring it again.</p>
                <button onClick={() => { void retryConfirm(); }} disabled={submitting}
                  className="w-full py-3.5 bg-[#A46832] hover:bg-[#A5642B] disabled:opacity-50 text-white rounded-2xl text-xs uppercase tracking-widest font-black cursor-pointer flex items-center justify-center gap-1.5">
                  <RefreshCcw className="h-3.5 w-3.5" /> {submitting ? 'Confirming…' : 'Retry confirmation'}
                </button>
              </div>
            )}
            </>)}
          </>
        )}
      </div>
    </div>
  );
};
