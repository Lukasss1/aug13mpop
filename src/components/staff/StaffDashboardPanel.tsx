import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight, ChevronLeft, Clock, Coffee, Power, Check, Share2 } from 'lucide-react';
import type { ClockHistoryItem, ClockStatus, EmployeeProfile, KnowledgeArticle, Payslip, StoreLocation, WorkShift } from '../../types';
import { STICKERS } from '../../brand';
import { routeToPath, handleAnchorNav } from '../../lib/router';
import { businessDateISOAt } from '../../lib/businessDate';
import { useSingleFlight } from '../../hooks/useSingleFlight';
import { storeStateKey, type ShiftCoverBoard } from '../../lib/storeState';
import { ActiveDutyTimer, StaffClockReadout } from './StaffClockTicker';
import { addIsoDays, buildStaffEarningsModel, buildStaffRotaModel, formatDateOnly, getShiftTimelinePosition } from './staffDashboardModel';

interface StaffDashboardPanelProps {
  isActive: boolean;
  employee: EmployeeProfile;
  currentStore?: StoreLocation | undefined;
  shiftsList: WorkShift[];
  clockHistory: ClockHistoryItem[];
  payslips: Payslip[];
  articles: KnowledgeArticle[];
  appState: Record<string, unknown>;
  staffDataStatus: 'idle' | 'loading' | 'live' | 'error';
  setCurrentTab: (tab: string) => void;
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  onClockAction: (action: 'clock_in' | 'start_break' | 'end_break' | 'clock_out', notes?: string) => Promise<{ status: ClockStatus; history: ClockHistoryItem | null } | null>;
  onRequestShiftCover: (shiftId: string, message: string) => Promise<ShiftCoverBoard | null>;
  onRetractShiftCover: (shiftId: string) => Promise<ShiftCoverBoard | null>;
  onClaimShift: (shiftId: string) => Promise<{ newShift: WorkShift; covers: Record<string, unknown> } | null>;
}

const StaffDashboardPanel: React.FC<StaffDashboardPanelProps> = ({
  isActive,
  employee,
  currentStore,
  shiftsList,
  clockHistory,
  payslips,
  articles,
  appState,
  staffDataStatus,
  setCurrentTab,
  addToast,
  onClockAction,
  onRequestShiftCover,
  onRetractShiftCover,
  onClaimShift,
}) => {
  const clockFlight = useSingleFlight();
  const coverFlight = useSingleFlight();

  // Persistent shift clock state.
  // SECURITY: identity comes ONLY from the `employee` prop (the authenticated
  // session). The old initializer read `milkpop_session` from localStorage —
  // the same forgeable key the login exploit used — so it was removed; the
  // effect below re-hydrates clock status once the real employee is known.
  const [clockStatus, setClockStatus] = useState<ClockStatus>(() => {
    const saved = employee ? appState[`milkpop_clock_status_${employee.id}`] : null;
    if (saved && typeof saved === 'object') return saved as ClockStatus;
    return { employeeId: '', status: 'clocked_out', lastActivity: new Date().toISOString() };
  });

  // Timesheet history now arrives via props (shared App state + Supabase
  // `clock_history` table) so store managers / the owner can approve hours.

  // Team-shift activity only changes at minute precision. One minute-level
  // refresh preserves that indicator without the old whole-portal 1 Hz render.
  const [operationalMinute, setOperationalMinute] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return undefined;
    setOperationalMinute(Date.now());
    const timer = window.setInterval(() => setOperationalMinute(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [isActive]);
  const shiftCoversKey = storeStateKey('milkpop_shift_covers', employee?.storeId);

  // Store-specific operational state. The database independently verifies the
  // key suffix against the authenticated profile's store.
  const [coverRequests, setCoverRequests] = useState<ShiftCoverBoard>({});

  // Roster weekday filter. Options: "all" or direct day code eg "Mon", "Tue" etc.
  const [rosterDayFilter, setRosterDayFilter] = useState<string>('all');

  // Clock Out brief user notes
  const [clockOutNotes, setClockOutNotes] = useState('');
  const [showClockOutNotesForm, setShowClockOutNotesForm] = useState(false);

  // Shift cover request text popup helper
  const [coverRequestMessageMap, setCoverRequestMessageMap] = useState<{ [shiftId: string]: string }>({});
  const [coverSubmittingId, setCoverSubmittingId] = useState<string | null>(null);


  // Hydrate the current store's cover board. Checklist state is owned by the
  // bounded StaffChecklistPanel so checklist edits do not rerender the portal.
  useEffect(() => {
    if (!employee || !shiftCoversKey) {
      setCoverRequests({});
      return;
    }
    const covers = appState[shiftCoversKey];
    setCoverRequests(covers && typeof covers === 'object' && !Array.isArray(covers)
      ? covers as ShiftCoverBoard
      : {});
  }, [employee?.id, employee?.storeId, appState, shiftCoversKey]);

  const [activeCoveringFormId, setActiveCoveringFormId] = useState<string | null>(null);

  const storeTimezone = currentStore?.timezone || 'Europe/London';
  const dashboardTodayIso = useMemo(
    () => businessDateISOAt(operationalMinute, storeTimezone),
    [operationalMinute, storeTimezone],
  );
  const rotaModel = useMemo(() => buildStaffRotaModel({
    shifts: shiftsList,
    covers: coverRequests,
    employeeId: employee.id,
    storeId: employee.storeId,
    selectedDate: rosterDayFilter,
    todayIso: dashboardTodayIso,
  }), [shiftsList, coverRequests, employee.id, employee.storeId, rosterDayFilter, dashboardTodayIso]);
  const earningsModel = useMemo(() => buildStaffEarningsModel({
    employee,
    clockHistory,
    payslips,
    now: operationalMinute,
    timezone: storeTimezone,
  }), [employee, clockHistory, payslips, operationalMinute, storeTimezone]);
  const latestArticles = useMemo(
    () => [...articles]
      .sort((left, right) => String(right.lastUpdated).localeCompare(String(left.lastUpdated)) || left.id.localeCompare(right.id))
      .slice(0, 2),
    [articles],
  );

  // Sync server-authoritative clock status when identity/KV data changes.
  useEffect(() => {
    if (!employee) return;
    const saved = appState[`milkpop_clock_status_${employee.id}`];
    if (saved && typeof saved === 'object') setClockStatus(saved as ClockStatus);
    else setClockStatus({ employeeId: employee.id, status: 'clocked_out', lastActivity: new Date().toISOString() });
  }, [employee?.id, appState]);

  // Clock operations
  /* FIX-3: while hydration is incomplete or failed, appState is empty and the
     clock status falls back to 'clocked_out' — showing "Clock In" to someone
     the DATABASE says is mid-shift. Acting on that lie would overwrite the
     real clockInTime. Every clock action is therefore hard-gated until the
     staff data is confirmed 'live'. */
  const [clockBusy, setClockBusy] = useState(false);
  const clockActionsDisabled = staffDataStatus !== 'live' || clockBusy || clockFlight.isBusy;
  /* T13-8 — STATE-DEPENDENT ACTIONS REQUIRE LIVE HYDRATION.
     The clock was already hard-gated (FIX-3) for exactly the right reason:
     acting on a partially hydrated list means writing a decision derived from
     data that may be stale or incomplete. The same reasoning covers every
     other action whose payload is built from a hydrated collection —
     checklist mutation/submission, Academy assessment submission, and
     shift-cover request/withdraw/claim. The server now mutates one checklist
     task or one cover entry atomically, but the action still requires a live
     hydrated view so the employee acts on current operational context.
     Reading reference content stays allowed; only writes are gated. Isolated
     server-validated actions the server can judge on their own (sign-in, an
     SIFR incident report) are deliberately NOT gated. */
  const stateActionsDisabled = staffDataStatus !== 'live';
  const STALE_STATE_MESSAGE = 'Internal data is not fully loaded. Retry before making changes.';
  const refuseIfNotLive = (): boolean => {
    if (!stateActionsDisabled) return false;
    addToast(STALE_STATE_MESSAGE, 'error');
    return true;
  };
  const clockGateTitle = clockActionsDisabled
    ? 'Loading your records — please wait before clocking in/out'
    : undefined;

  const handleClockIn = async (): Promise<void> => {
    if (clockActionsDisabled || !employee) return;
    await clockFlight.run('clock-in', async () => {
      setClockBusy(true);
      try {
        const res = await onClockAction('clock_in');
        if (!res) { addToast('Clock-in could not be recorded — check your connection and try again.', 'error'); return; }
        setClockStatus(res.status);
        addToast('Successfully clocked in.', 'success');
      } finally { setClockBusy(false); }
    });
  };

  const handleStartBreak = async (): Promise<void> => {
    if (clockActionsDisabled || !employee || clockStatus.status !== 'clocked_in') return;
    await clockFlight.run('start-break', async () => {
      setClockBusy(true);
      try {
        const res = await onClockAction('start_break');
        if (!res) { addToast('The break could not be recorded — check your connection and try again.', 'error'); return; }
        setClockStatus(res.status);
        addToast('Break started.', 'warning');
      } finally { setClockBusy(false); }
    });
  };

  const handleEndBreak = async (): Promise<void> => {
    if (clockActionsDisabled || !employee || clockStatus.status !== 'on_break' || !clockStatus.breakStartTime) return;
    await clockFlight.run('end-break', async () => {
      setClockBusy(true);
      try {
        const res = await onClockAction('end_break');
        if (!res) { addToast('The break end could not be recorded — check your connection and try again.', 'error'); return; }
        setClockStatus(res.status);
        addToast('Break ended.', 'success');
      } finally { setClockBusy(false); }
    });
  };

  const handleClockOutSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (clockActionsDisabled) return;
    if (!employee || (clockStatus.status !== 'clocked_in' && clockStatus.status !== 'on_break') || !clockStatus.clockInTime) return;
    await clockFlight.run('clock-out', async () => {
      setClockBusy(true);
      try {
        const res = await onClockAction('clock_out', clockOutNotes.trim() || undefined);
        if (!res) { addToast('The server did not confirm clock-out. Reload your time record before retrying.', 'error'); return; }
        setClockStatus(res.status);
        setShowClockOutNotesForm(false);
        setClockOutNotes('');
        const hours = res.history?.totalDecimalHours ?? 0;
        addToast(`Clocked out. ${hours} hours were recorded and are pending manager approval.`, 'success');
      } finally { setClockBusy(false); }
    });
  };

  // Shift cover logic
  const handlePublishCoverRequest = async (shiftId: string): Promise<void> => {
    if (refuseIfNotLive()) return;
    if (!employee || !shiftCoversKey) {
      addToast('A store assignment is required before using shift cover.', 'error');
      return;
    }
    const message = String(coverRequestMessageMap[shiftId] || '').trim();
    if (message.length < 3) {
      addToast('Enter at least three characters explaining why you need cover.', 'error');
      return;
    }
    await coverFlight.run(`request:${shiftId}`, async () => {
      setCoverSubmittingId(shiftId);
      try {
        const covers = await onRequestShiftCover(shiftId, message);
        if (!covers) {
          addToast('Coverage request was not posted. Check the shift and try again.', 'error');
          return;
        }
        setCoverRequests(covers);
        setActiveCoveringFormId(null);
        setCoverRequestMessageMap((previous) => ({ ...previous, [shiftId]: '' }));
        addToast('Coverage request posted to your store team.', 'success');
      } finally {
        setCoverSubmittingId(null);
      }
    });
  };

  const handleRetractCoverRequest = async (shiftId: string): Promise<void> => {
    if (refuseIfNotLive()) return;
    if (!shiftCoversKey) {
      addToast('A store assignment is required before using shift cover.', 'error');
      return;
    }
    await coverFlight.run(`retract:${shiftId}`, async () => {
      setCoverSubmittingId(shiftId);
      try {
        const covers = await onRetractShiftCover(shiftId);
        if (!covers) {
          addToast('Coverage request could not be withdrawn. Reload and try again.', 'error');
          return;
        }
        setCoverRequests(covers);
        addToast('Coverage request withdrawn.', 'warning');
      } finally {
        setCoverSubmittingId(null);
      }
    });
  };

  const handleClaimCoverShift = async (shift: WorkShift): Promise<void> => {
    if (refuseIfNotLive()) return; // T13-8
    if (!employee) return;
    if (shift.employeeId === employee.id) {
      addToast('You already own this shift!', 'error');
      return;
    }

    // FIX (audit OPS-002): the claim is ONE server transaction (claim_shift):
    // open-cover check, store scope, overlap check, reassignment and advert
    // close happen atomically under row locks — two simultaneous claimers get
    // exactly one winner, and a failure changes nothing.
    await coverFlight.run(`claim:${shift.id}`, async () => {
      setCoverSubmittingId(shift.id);
      try {
        const res = await onClaimShift(shift.id);
        if (!res) {
          addToast('This shift could not be claimed — it may have just been taken, or it clashes with your rota.', 'error');
          return;
        }
        setCoverRequests(res.covers as typeof coverRequests);
        addToast(`Roster transfer secured! You are now scheduled for ${shift.date} (${shift.startTime}-${shift.endTime}). Thanks for supporting the team! ❤️`, 'success');
      } finally {
        setCoverSubmittingId(null);
      }
    });
  };

  // Helper: check if a shift date corresponds to a specific day profile
  // Helper: determine if a teammate is online right now based on shift list today
  const isTeammateCurrentlyShiftActive = (sh: WorkShift): boolean => {
    try {
      const timezone = storeTimezone;
      const todayString = dashboardTodayIso;
      const previousDate = addIsoDays(todayString, -1);
      const timeParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(operationalMinute));
      const currentHour = Number(timeParts.find((part) => part.type === 'hour')?.value || 0);
      const currentMin = Number(timeParts.find((part) => part.type === 'minute')?.value || 0);
      const [startHour = 0, startMin = 0] = sh.startTime.split(':').map(Number);
      const [endHour = 0, endMin = 0] = sh.endTime.split(':').map(Number);
      const nowMinutes = currentHour * 60 + currentMin;
      const startMinutes = startHour * 60 + startMin;
      const endMinutes = endHour * 60 + endMin;
      if (endMinutes > startMinutes) return sh.date === todayString && nowMinutes >= startMinutes && nowMinutes <= endMinutes;
      
  return (sh.date === todayString && nowMinutes >= startMinutes) || (sh.date === previousDate && nowMinutes <= endMinutes);
    } catch {
      return false;
    }
  };





  // Staff Dashboard interactive rota view state
  const [dashboardRotaTab, setDashboardRotaTab] = useState<'my_rota' | 'store_team' | 'open_swaps'>('my_rota');
  const daysScrollRef = useRef<HTMLDivElement>(null);
  
  const scrollDays = (direction: 'left' | 'right') => {
    if (daysScrollRef.current) {
      const scrollAmount = 250;
      daysScrollRef.current.scrollBy({ left: direction === 'left' ? -scrollAmount : scrollAmount, behavior: 'smooth' });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start text-left">
      {/* Left Column (8 cols): Clocking console, advanced roster filters */}
      <div className="lg:col-span-8 space-y-8">

        {/* 1. CLOCK IN & OUT EXECUTIVE CONSOLE */}
        <div className="bg-white p-6 sm:p-8 mp-blob-l mp-shadow border border-[#EBDECE] relative overflow-hidden">
          {/* Brand accent — cup sticker peeking, deliberately off-corner */}
          <img src={STICKERS.cup} alt="" aria-hidden="true" width={213} height={393} decoding="async" className="absolute -bottom-4 -right-3 w-16 opacity-15 rotate-[10deg] pointer-events-none select-none" />
          {/* Subtle ambient status light */}
          <div className={`absolute top-0 right-0 w-32 h-32 rounded-full filter blur-3xl opacity-20 transition-colors duration-500 pointer-events-none ${
            clockStatus.status === 'clocked_in' ? 'bg-emerald-500' :
            clockStatus.status === 'on_break' ? 'bg-amber-500' : 'bg-rose-500'
          }`} />

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 relative z-10">
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <span className={`h-2.5 w-2.5 rounded-full inline-block ${
                  clockStatus.status === 'clocked_in' ? 'bg-emerald-500 animate-pulse' :
                  clockStatus.status === 'on_break' ? 'bg-amber-500 animate-pulse' : 'bg-neutral-300'
                }`} />
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-neutral-400">
                  {clockStatus.status === 'clocked_in' ? 'Clocked in' :
                   clockStatus.status === 'on_break' ? 'On break' : 'Clocked out'}
                </span>
              </div>

              {/* The one-second ticker lives in this small component, so Academy,
                  documents and other inactive portal domains do not rerender each second. */}
              <StaffClockReadout timezone={currentStore?.timezone || 'Europe/London'} active={isActive} />
            </div>

            {/* Clock control layout */}
            <div className="w-full sm:w-auto flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
              {clockStatus.status === 'clocked_out' && (
                <button
                  onClick={handleClockIn}
                  disabled={clockActionsDisabled}
                  title={clockGateTitle}
                  className="px-6 py-4 disabled:opacity-50 disabled:cursor-not-allowed bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold uppercase tracking-wider rounded-2xl cursor-pointer flex items-center justify-center space-x-2 transition-all shadow-xs"
                >
                  <Power className="w-4 h-4" />
                  <span>Clock In Shift</span>
                </button>
              )}

              {clockStatus.status === 'clocked_in' && (
                <>
                  <button
                    onClick={handleStartBreak}
                    disabled={clockActionsDisabled}
                    title={clockGateTitle}
                    className="px-5 py-4 disabled:opacity-50 disabled:cursor-not-allowed bg-amber-500 hover:bg-amber-600 text-white text-xs font-extrabold uppercase tracking-wider rounded-2xl cursor-pointer flex items-center justify-center space-x-2 transition-all shadow-xs"
                  >
                    <Coffee className="w-4 h-4" />
                    <span>Start Break</span>
                  </button>
                  <button
                    onClick={() => setShowClockOutNotesForm(true)}
                    disabled={clockActionsDisabled}
                    title={clockGateTitle}
                    className="px-5 py-4 disabled:opacity-50 disabled:cursor-not-allowed bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold uppercase tracking-wider rounded-2xl cursor-pointer flex items-center justify-center space-x-2 transition-all shadow-xs"
                  >
                    <Power className="w-4 h-4 animate-pulse" />
                    <span>Clock Out</span>
                  </button>
                </>
              )}

              {clockStatus.status === 'on_break' && (
                <>
                  <button
                    onClick={handleEndBreak}
                    disabled={clockActionsDisabled}
                    title={clockGateTitle}
                    className="px-5 py-4 disabled:opacity-50 disabled:cursor-not-allowed bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold uppercase tracking-wider rounded-2xl cursor-pointer flex items-center justify-center space-x-2 transition-all shadow-xs"
                  >
                    <Check className="w-4 h-4" />
                    <span>End Break</span>
                  </button>
                  <button
                    onClick={() => setShowClockOutNotesForm(true)}
                    disabled={clockActionsDisabled}
                    title={clockGateTitle}
                    className="px-5 py-4 disabled:opacity-50 disabled:cursor-not-allowed bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold uppercase tracking-wider rounded-2xl cursor-pointer flex items-center justify-center space-x-2 transition-all shadow-xs"
                  >
                    <Power className="w-4 h-4" />
                    <span>Clock Out</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Dynamic Shift Calculator status info */}
          {(clockStatus.status === 'clocked_in' || clockStatus.status === 'on_break') && clockStatus.clockInTime && (
            <div className="mt-6 pt-5 border-t border-neutral-100 flex flex-wrap items-center justify-between gap-4 text-xs">
              <div className="flex items-center space-x-2 bg-neutral-50 px-3.5 py-2 rounded-xl">
                <Clock className="w-4 h-4 text-neutral-400" />
                <span className="text-neutral-500">Clocked In at:</span>
                <strong className="text-neutral-800">
                  {new Date(clockStatus.clockInTime).toLocaleTimeString('en-GB', { timeZone: currentStore?.timezone || 'Europe/London', hour: '2-digit', minute: '2-digit' })}
                </strong>
              </div>

              <div className="flex items-center space-x-2 bg-neutral-50 px-3.5 py-2 rounded-xl">
                <Coffee className="w-4 h-4 text-neutral-400" />
                <span className="text-neutral-500">Break Balance logged:</span>
                <strong className="text-neutral-800">
                  {Math.round((clockStatus.accumulatedBreakMs || 0) / 60000)} mins
                </strong>
              </div>

              <ActiveDutyTimer clockStatus={clockStatus} active={isActive} />
            </div>
          )}

          {/* Interactive Clock Out Notes popup drawer (inline to avoid iframe block issues) */}
          {showClockOutNotesForm && (
            <div className="mt-6 pt-6 border-t border-rose-100 bg-rose-50/20 p-5 rounded-2xl text-left space-y-4">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-sm font-extrabold text-rose-900">shift summaries reports</h3>
                  <p className="text-2xs text-rose-800/80">Log any important handover observations before closing your terminal node.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowClockOutNotesForm(false)}
                  className="text-neutral-400 hover:text-neutral-600 font-extrabold text-xs cursor-pointer"
                >
                  Cancel
                </button>
              </div>

              <form onSubmit={handleClockOutSubmit} className="space-y-3">
                <textarea
                  aria-label="Shift handover notes"
                  value={clockOutNotes}
                  onChange={(e) => setClockOutNotes(e.target.value)}
                  placeholder="e.g., Ice storage re-stocked, till logs balance out fine. Machine elements self-cleaned."
                  className="w-full max-h-32 p-3 bg-white border border-rose-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-rose-500 text-xs placeholder:text-neutral-400"
                />
                <button
                  type="submit"
                  disabled={clockActionsDisabled}
                  title={clockGateTitle}
                  className="px-5 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-2xs font-extrabold uppercase tracking-wide cursor-pointer"
                >
                  Submit Checkout logs & Clock Out
                </button>
              </form>
            </div>
          )}
        </div>

        {/* 2. ADVANCED INTERACTIVE ROSTER MODULE */}
        <div className="bg-white p-6 sm:p-8 rounded-3xl border border-[#EBDECE] space-y-6">

          {/* module title & multi-view navigation controls */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-neutral-100 pb-5">
            <div className="space-y-1">
              <h4 className="font-display text-[9px] uppercase tracking-widest text-neutral-400 font-bold">advanced roster system</h4>
              <h3 className="text-base font-extrabold text-[#2E2A26] flex items-center gap-1.5">
                <span>My rota</span>
                <span className="h-1.5 w-1.5 bg-[#A46832] rounded-full inline-block" />
                <span className="text-[#A46832] text-xs font-normal">{employee.storeName}</span>
              </h3>
            </div>

            {/* Navigation tab bar */}
            <div className="bg-neutral-100 p-1 rounded-full flex items-center space-x-1 self-stretch md:self-auto overflow-x-auto scrollbar-none shrink-0">
              {[
                { key: 'my_rota', label: 'My Shifts' },
                { key: 'store_team', label: 'Teammates' },
                { key: 'open_swaps', label: 'Swaps Board 📣' }
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => {
                    setDashboardRotaTab(tab.key as any);
                  }}
                  className={`px-4 py-2 rounded-full text-[9px] font-extrabold uppercase tracking-wider transition-all whitespace-nowrap cursor-pointer ${
                    dashboardRotaTab === tab.key
                      ? 'bg-[#2E2A26] text-white shadow-xs'
                      : 'text-neutral-500 hover:text-neutral-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* WEEK CIRCLE SELECTION PANEL (Apple style) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-2xs">
              <span className="text-neutral-400 font-bold uppercase tracking-wider">Scroll Days of Current Cycle</span>
              <button
                onClick={() => setRosterDayFilter('all')}
                className={`font-extrabold uppercase px-2.5 py-0.5 rounded-full tracking-wider text-[8px] border transition-all cursor-pointer ${
                  rosterDayFilter === 'all'
                    ? 'bg-[#A46832]/10 text-[#A46832] border-[#A46832]/30'
                    : 'text-neutral-400 hover:text-[#2E2A26] border-transparent'
                }`}
              >
                All Cycle Days
              </button>
            </div>

            <div className="relative flex items-center group">
              <button
                type="button"
                aria-label="Show earlier rota days"
                onClick={() => scrollDays('left')}
                className="absolute left-0 z-10 min-h-11 min-w-11 bg-white/90 border border-neutral-200 rounded-full shadow-sm text-neutral-400 hover:text-[#2E2A26] -ml-2 transition-opacity opacity-0 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer grid place-items-center"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>

              {/* horizontal selector list */}
              <div ref={daysScrollRef} className="flex items-center gap-2.5 overflow-x-auto pb-2 scrollbar-none shrink-0 w-full scroll-smooth" style={{ scrollbarWidth: 'none' }}>
                {rotaModel.cycleDays.map((targetDay) => {
                  const isSelected = rosterDayFilter === targetDay.dateCode;
                  let buttonBg = 'bg-neutral-50/50 hover:bg-neutral-50 border-neutral-200 text-neutral-600';
                  if (isSelected) {
                    buttonBg = 'bg-[#2E2A26] border-[#2E2A26] text-white shadow-xs scale-102';
                  } else if (targetDay.hasShift) {
                    buttonBg = 'bg-[#A46832]/10 hover:bg-[#A46832]/20 border-[#A46832]/30 text-[#2E2A26] font-bold';
                  }
                  return (
                    <button
                      key={targetDay.dateCode}
                      type="button"
                      onClick={() => setRosterDayFilter(targetDay.dateCode)}
                      className={`flex flex-col items-center justify-center min-w-[55px] h-16 rounded-2xl border transition-all cursor-pointer ${buttonBg}`}
                    >
                      <span className={`text-[9px] uppercase font-bold tracking-wider ${isSelected ? 'opacity-60' : targetDay.hasShift ? 'opacity-80 text-[#A46832]' : 'opacity-60'}`}>
                        {targetDay.code}
                      </span>
                      <span className="text-sm font-extrabold relative">{targetDay.num}</span>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                aria-label="Show later rota days"
                onClick={() => scrollDays('right')}
                className="absolute right-0 z-10 min-h-11 min-w-11 bg-white/90 border border-neutral-200 rounded-full shadow-sm text-neutral-400 hover:text-[#2E2A26] -mr-2 transition-opacity opacity-0 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer grid place-items-center"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* ACTIVE TAB RENDER BLOCK */}

          {/* TIMELINE HELPER FUNCTIONS */}
          {(() => {
            const getShiftPosition = getShiftTimelinePosition;

            const renderTimelineScale = () => (
                <div className="absolute top-0 bottom-0 left-0 right-0 pointer-events-none flex justify-between z-0">
                    {[7, 10, 13, 16, 19, 22].map((hour, idx, arr) => (
                        <div key={hour} className="h-full border-l border-neutral-200/60 relative" style={{ width: idx === arr.length - 1 ? '0' : '100%' }}>
                          <span className="text-[8px] font-mono font-extrabold text-[#D2C5B4] absolute -left-3 -top-5 px-1">{hour}:00</span>
                        </div>
                    ))}
                </div>
            );

            return (
              <>
                {/* TAB 1: MY SHIFTS - Visual Timeline */}
                {dashboardRotaTab === 'my_rota' && (
                  <div className="space-y-4">
                    {rotaModel.myShifts.length === 0 ? (
                      <div className="text-center py-10 bg-neutral-50/50 rounded-2xl border border-dashed border-neutral-200">
                        <p className="text-xs font-medium text-neutral-400">You have no shifts allocated in this cycle.</p>
                      </div>
                    ) : rotaModel.visibleMyShifts.length === 0 ? (
                      <div className="text-center py-10 bg-neutral-50/50 rounded-2xl border border-dashed border-neutral-200">
                        <p className="text-xs font-medium text-neutral-400">No shifts on the selected day.</p>
                      </div>
                    ) : (
                      <div className="space-y-8 mt-6">
                        {rotaModel.visibleMyShifts.map((sh, index) => {
                            const pendingCover = !!coverRequests[sh.id];
                            const pos = getShiftPosition(sh.startTime, sh.endTime);

                            return (
                              <div key={sh.id} className="relative space-y-4">
                                <div className="flex justify-between items-end mb-2">
                                  <div className="flex items-center gap-2">
                                    <h4 className="text-[10px] uppercase font-extrabold text-[#2E2A26] tracking-widest">
                                      {formatDateOnly(sh.date, { weekday: 'long', day: 'numeric', month: 'long' })}
                                    </h4>
                                    <span className={`text-[8px] uppercase tracking-widest font-extrabold px-1.5 py-0.5 rounded inline-block ${
                                      sh.type === 'opening' ? 'bg-[#EBF7F2] text-[#3F8766]' :
                                      sh.type === 'closing' ? 'bg-[#FCF1F3] text-[#A24A5D]' :
                                      'bg-amber-50 text-[#A46832]'
                                    }`}>
                                      {sh.type}
                                    </span>
                                  </div>
                                  {pendingCover && (
                                    <span className="text-[8px] font-extrabold tracking-widest bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded animate-pulse uppercase">
                                      Swap Pending
                                    </span>
                                  )}
                                </div>

                                <div className="relative pt-6 pb-2 min-h-[60px] bg-neutral-50/30 rounded-xl px-2">
                                    {renderTimelineScale()}
                                    <motion.div 
                                      initial={{ width: 0, opacity: 0 }}
                                      animate={{ width: pos.width, opacity: 1 }}
                                      transition={{ duration: 0.8, delay: index * 0.1, ease: 'easeOut' }}
                                      className="absolute top-6 bottom-2 rounded-lg bg-[#2E2A26] border border-[#2E2A26] shadow-xs flex items-center overflow-hidden z-10 group cursor-pointer"
                                      style={{ left: pos.left, minWidth: '40px' }}
                                    >
                                      <div className="absolute inset-0 bg-gradient-to-r from-white/10 to-transparent"></div>
                                      <div className="px-2 truncate w-full flex justify-between items-center z-10 text-white/90">
                                        <span className="font-mono text-[9px] font-bold">{sh.startTime}</span>
                                        <span className="font-mono text-[9px] font-bold">{sh.endTime}</span>
                                      </div>
                                      {/* Hover tooltip essentially implicitly built into actions below */}
                                    </motion.div>
                                </div>

                                {/* Action buttons simple toggle */}
                                <div className="flex justify-end pt-1">
                                    <button
                                      type="button"
                                      onClick={() => setActiveCoveringFormId(activeCoveringFormId === sh.id ? null : sh.id)}
                                      className="text-[9px] font-extrabold text-neutral-400 hover:text-[#A46832] uppercase tracking-wider transition-colors"
                                    >
                                      {pendingCover ? 'Manage Swap Request' : 'Can no longer work?'}
                                    </button>
                                </div>

                                {/* Inline Quick coverage post note */}
                                <AnimatePresence>
                                  {activeCoveringFormId === sh.id && (
                                    <motion.div 
                                      initial={{ opacity: 0, y: -10, height: 0 }}
                                      animate={{ opacity: 1, y: 0, height: 'auto' }}
                                      exit={{ opacity: 0, y: -10, height: 0 }}
                                      className="pt-2 bg-orange-50/20 p-4 border border-dashed border-orange-200 rounded-xl overflow-hidden"
                                    >
                                      <p className="text-2xs text-[#2E2A26] font-semibold mb-2">Write a short note so colleagues see why you need cover:</p>
                                      <div className="flex gap-2">
                                        <input
                                          aria-label={`Cover request note for ${sh.employeeName || 'this shift'}`}
                                          type="text"
                                          placeholder="e.g. Urgent family commit clash or study exams cover needed."
                                          value={coverRequestMessageMap[sh.id] || ''}
                                          onChange={(e) => setCoverRequestMessageMap({
                                            ...coverRequestMessageMap,
                                            [sh.id]: e.target.value
                                          })}
                                          className="w-full text-xs p-2.5 bg-white border border-neutral-200 rounded-lg focus:outline-none"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => { void handlePublishCoverRequest(sh.id); }}
                                          disabled={coverSubmittingId === sh.id || staffDataStatus !== 'live'}
                                          className="px-4 bg-[#A46832] hover:bg-[#2E2A26] text-white text-[9px] font-extrabold uppercase rounded-lg shrink-0 cursor-pointer transition-colors"
                                        >
                                          {coverSubmittingId === sh.id ? 'Posting…' : pendingCover ? 'Update' : 'Publish'}
                                        </button>
                                        {pendingCover && (
                                          <button
                                            onClick={() => void handleRetractCoverRequest(sh.id)}
                                            disabled={coverSubmittingId === sh.id || staffDataStatus !== 'live'}
                                            className="px-4 bg-neutral-200 text-neutral-700 hover:bg-neutral-300 font-extrabold text-[9px] uppercase tracking-wider rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                                          >
                                            {coverSubmittingId === sh.id ? 'Withdrawing…' : 'Retract'}
                                          </button>
                                        )}
                                      </div>
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 2: STORE TEAMMATES ROTATION - Horizontal Gantt View */}
                {dashboardRotaTab === 'store_team' && (
                  <div className="space-y-8 mt-6">
                    {rotaModel.teamShifts.length === 0 ? (
                      <div className="text-center py-10 bg-neutral-50/50 rounded-2xl border border-dashed border-neutral-200">
                        <p className="text-xs font-medium text-neutral-400">No colleague duty records found in this cycle.</p>
                      </div>
                    ) : rotaModel.visibleTeamShifts.length === 0 ? (
                      <div className="text-center py-10 bg-neutral-50/50 rounded-2xl border border-dashed border-neutral-200">
                        <p className="text-xs font-medium text-neutral-400">No teammate shifts on the selected day.</p>
                      </div>
                    ) : (
                      <div className="space-y-8">
                        {rotaModel.teamDates.map((dateStr) => {
                            const dailyShifts = rotaModel.teamShiftsByDate.get(dateStr) || [];

                            return (
                                <div key={dateStr} className="space-y-4 relative">
                                    <h4 className="text-[10px] uppercase font-extrabold text-[#2E2A26] tracking-widest border-b border-neutral-100 pb-2">
                                      {formatDateOnly(dateStr, { weekday: 'long', day: 'numeric', month: 'long' })}
                                    </h4>

                                    <div className="relative pt-6 pb-2 min-h-[100px] bg-neutral-50/40 rounded-2xl px-2">
                                        {renderTimelineScale()}

                                        <div className="relative z-10 flex flex-col gap-2 mt-2">
                                            {dailyShifts.map((sh, idx) => {
                                                const isActiveNow = isTeammateCurrentlyShiftActive(sh);
                                                const pos = getShiftPosition(sh.startTime, sh.endTime);
                                                return (
                                                    <div key={sh.id} className="relative h-10 w-full flex items-center group">
                                                        <motion.div 
                                                            initial={{ width: 0, opacity: 0 }}
                                                            animate={{ width: pos.width, opacity: 1 }}
                                                            transition={{ duration: 0.6, delay: idx * 0.1, ease: 'easeOut' }}
                                                            className={`absolute h-full rounded-xl flex items-center px-2 overflow-hidden shadow-xs cursor-default ${isActiveNow ? 'bg-emerald-500 text-white' : 'bg-[#EBDECE]/80 text-[#2E2A26]'}`}
                                                            style={{ left: pos.left, minWidth: '120px' }}
                                                        >
                                                            <div className="relative z-10 flex items-center justify-between w-full h-full pb-0.5">
                                                                 <span className="text-[10px] font-extrabold uppercase tracking-wide truncate pr-2 flex items-center gap-1.5">
                                                                   {isActiveNow && <span className="h-1.5 w-1.5 rounded-full bg-white animate-ping block"></span>}
                                                                   {sh.employeeName}
                                                                 </span>
                                                                 <span className="font-mono text-[9px] font-bold opacity-70 whitespace-nowrap">{sh.startTime} - {sh.endTime}</span>
                                                            </div>
                                                        </motion.div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </>
            );
          })()}

          {/* TAB 3: OPEN COVERS SHEET */}
          {dashboardRotaTab === 'open_swaps' && (
            <div className="space-y-4">
              {rotaModel.openCoverShifts.length === 0 ? (
                <div className="text-center py-10 bg-neutral-50/50 rounded-2xl border border-dashed border-neutral-200 space-y-2">
                  <p className="text-xs font-semibold text-neutral-500">Perfect Coverage! 🌴</p>
                  <p className="text-2xs text-[#2E2A26]/70 max-w-sm mx-auto leading-relaxed">
                    No open cover requests right now. This shows swap-assistance requests only — it does not confirm every shift is staffed; check the rota for allocations.
                  </p>
                </div>
              ) : (
                <div className="space-y-3.5">
                  <div className="bg-yellow-50/40 border border-yellow-200 rounded-2xl p-4 text-2xs leading-relaxed text-yellow-900">
                    ⭐ <strong>Roster Swaps Rules:</strong> When you claim another colleague's shift, their shift allocation immediately transfers to you. Make sure you are free to complete the shift!
                  </div>

                  {rotaModel.openCoverShifts.map((sh) => {
                      const requestInfo = coverRequests[sh.id];
                      if (!requestInfo) return null;
                      const isSelfShift = (sh.employeeId === employee.id);
                      return (
                        <div
                          key={sh.id}
                          className="p-5 bg-white border border-neutral-300/60 rounded-3xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 text-left shadow-2xs hover:shadow-xs transition-shadow"
                        >
                          <div className="space-y-2.5 max-w-md">
                            <div className="flex items-center space-x-2">
                              <span className="text-[9px] uppercase font-extrabold tracking-widest bg-orange-100 text-orange-800 px-2.5 py-0.5 rounded-md">
                                Cover Wanted
                              </span>
                              <p className="text-[9px] text-neutral-400 font-mono">Posted: {new Date(requestInfo.date).toLocaleDateString('en-GB')}</p>
                            </div>

                            <div>
                              <h3 className="text-xs font-bold text-neutral-800">
                                Colleague <strong className="text-neutral-900">{sh.employeeName}</strong> needs cover on week rotation code
                              </h3>
                              <p className="text-xs font-extrabold text-[#A46832] mt-0.5">
                                {formatDateOnly(sh.date, { weekday: 'long', day: 'numeric', month: 'short' })} • {sh.startTime} - {sh.endTime} ({sh.type})
                              </p>
                            </div>

                            <div className="bg-neutral-50 p-3 rounded-xl border border-neutral-100 text-[11px] text-neutral-500 italic">
                              "{requestInfo.message}"
                            </div>
                          </div>

                          <div className="shrink-0 w-full md:w-auto">
                            {isSelfShift ? (
                              <button
                                onClick={() => void handleRetractCoverRequest(sh.id)}
                                disabled={coverSubmittingId === sh.id || staffDataStatus !== 'live'}
                                className="w-full md:w-auto px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded-xl text-3xs font-extrabold uppercase tracking-wide cursor-pointer disabled:opacity-50"
                              >
                                {coverSubmittingId === sh.id ? 'Withdrawing…' : 'Retract Request'}
                              </button>
                            ) : (
                              <button
                                onClick={() => void handleClaimCoverShift(sh)}
                                disabled={coverSubmittingId === sh.id || staffDataStatus !== 'live'}
                                className="w-full md:w-auto px-5 py-3 bg-[#2E2A26] hover:bg-emerald-600 text-white rounded-xl text-3xs font-extrabold uppercase tracking-widest cursor-pointer shadow-xs transition-all flex items-center justify-center space-x-1.5 disabled:opacity-50"
                              >
                                <Share2 className="w-3.5 h-3.5" />
                                <span>{coverSubmittingId === sh.id ? 'Claiming…' : 'Claim Roster Cover'}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 3. QUICK LINKS MODULE SHORTCUTS */}
        <div className="space-y-4">
          <h3 className="font-display text-xs uppercase font-extrabold tracking-widest text-[#A46832]">Quick links</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: 'My Documents', key: 'staff_documents', sym: '📂' },
              { label: 'Training Academy', key: 'staff_academy', sym: '🎓' },
              { label: 'Incident SIFRs', key: 'staff_sifr', sym: '📜' },
              { label: 'Recipes Wiki', key: 'staff_kb', sym: '📖' }
            ].map((link, i) => (
              <a
                id={`dash-quick-${link.key}`}
                key={i}
                href={routeToPath(link.key)}
                onClick={(e) => handleAnchorNav(e, () => setCurrentTab(link.key))}
                className="block bg-white p-6 rounded-2xl border border-[#EBDECE]/50 shadow-2xs hover:shadow-xs hover:border-[#A46832] transition-all text-center space-y-2 cursor-pointer focus:outline-none"
              >
                <span className="text-xl block">{link.sym}</span>
                <span className="block text-[10px] font-black uppercase tracking-wider text-gray-600">{link.label}</span>
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Right Column (4 cols): Personal Timesheets, Achievements */}
      <div className="lg:col-span-4 space-y-6">

        {/* PERSONAL TIMESHEET HISTORY / HISTORICAL PAYOUT COMPLIANCE */}
        <div className="bg-white p-6 mp-blob-r mp-shadow border border-[#EBDECE] space-y-4 text-left">
          <div className="flex justify-between items-center">
            <h3 className="font-display text-xs uppercase font-extrabold tracking-widest text-[#A46832]">Personal Timesheets</h3>
            <span className="text-[8px] tracking-wider uppercase font-extrabold bg-[#A46832]/10 text-[#A46832] px-2.5 py-0.5 rounded-full inline-block mp-tilt-r">
              Your hours
            </span>
          </div>

          <div className="space-y-3.5">
            {earningsModel.timesheets.length === 0 ? (
              <p className="text-2xs text-[#2E2A26]/40 italic">Nothing logged yet — your clock-outs will appear here.</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {earningsModel.timesheets.map((log) => {
                    /* SMALL-BIZ CLOSURE P0-10: the shared rule from
                       src/lib/pay.ts — no configured rate means the
                       chip row shows HOURS only, never invented cash
                       (the old code substituted £11.44/hr and guessed
                       the salary period from the number's size). */
                    const hourlyRate = earningsModel.hourlyRate;
                    const shiftPay = hourlyRate === null ? null : (log.totalDecimalHours || 0) * hourlyRate;
                    return (
                      <div key={log.id} className="p-3 bg-[#F7EFE6]/70 rounded-xl rounded-br-sm border border-[#EBDECE] text-left space-y-1">
                        <div className="flex justify-between items-baseline">
                          <span className="text-2xs font-extrabold text-neutral-800">
                            {formatDateOnly(log.date, { day: 'numeric', month: 'short' })}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono font-bold text-neutral-600 bg-neutral-200/50 px-2 py-0.5 rounded-md">
                              {log.totalDecimalHours} hrs
                            </span>
                            {shiftPay !== null && (
                            <span className="text-[10px] font-mono font-bold text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-md">
                              £{shiftPay.toFixed(2)}
                            </span>
                            )}
                          </div>
                        </div>

                        <div className="flex justify-between items-center text-[10px] text-neutral-400">
                          <span>
                            {new Date(log.clockIn).toLocaleTimeString('en-GB', { timeZone: storeTimezone, hour: '2-digit', minute: '2-digit' })} - {log.clockOut ? new Date(log.clockOut).toLocaleTimeString('en-GB', { timeZone: storeTimezone, hour: '2-digit', minute: '2-digit' }) : 'Pending'}
                          </span>
                          {log.rejected ? (
                            <span className="font-bold text-[8px] uppercase tracking-wider text-red-500">● Rejected</span>
                          ) : log.approved ? (
                            <span className="font-bold text-[8px] uppercase tracking-wider text-emerald-600" title={log.approvedBy ? `Approved by ${log.approvedBy}` : undefined}>● Approved</span>
                          ) : (
                            <span className="font-bold text-[8px] uppercase tracking-wider text-amber-500">● Pending approval</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            {/* Hours and honest earnings summary. Salaried pay is never
                inferred from clocked hours; payroll remains authoritative. */}
            {(() => {
              const {
                isSalary,
                hourlyRate,
                currentMonthHours: thisMonthHrs,
                previousMonthLabel: prevLabel,
                previousEstimate: prevEstimate,
                previousApprovedHours: prevApprovedHrs,
                previousGross,
              } = earningsModel;

              return (
                <div className="p-4 bg-[#2E2A26] text-white mp-blob-b space-y-3">
                  <div>
                    <span className="text-[9px] uppercase tracking-widest opacity-60 font-medium block">Logged this cycle</span>
                    <span className="text-base font-mono font-bold">
                      {thisMonthHrs.toFixed(1)} hrs
                      {!isSalary && hourlyRate !== null && (
                        <span className="opacity-70 text-sm ml-2 font-normal">(£{(thisMonthHrs * hourlyRate).toFixed(2)} estimated gross)</span>
                      )}
                    </span>
                    {isSalary ? (
                      <span className="block text-[9px] opacity-65 italic mt-1">
                        Salaried employee — pay is handled through payroll and is not calculated from timesheet hours here.
                        {typeof employee.payRate === 'number' && employee.payRate > 0 ? ` Annual salary: £${employee.payRate.toLocaleString('en-GB')}.` : ''}
                      </span>
                    ) : hourlyRate === null ? (
                      <span className="block text-[9px] opacity-60 italic">Pay rate not configured — hours are still recorded.</span>
                    ) : null}
                  </div>
                  <div className="flex justify-between items-center border-t border-white/15 pt-3">
                    <div>
                      <span className="text-[9px] uppercase tracking-widest opacity-60 font-medium block">Previous estimate · {prevLabel}</span>
                      {isSalary ? (
                        <span className="text-xs font-medium text-white/70">Handled through payroll</span>
                      ) : previousGross === null ? (
                        <span className="text-base font-mono font-bold text-white/60 italic">Not available</span>
                      ) : (
                        <span className="text-base font-mono font-bold text-emerald-300">£{previousGross.toFixed(2)} estimated gross</span>
                      )}
                      {!isSalary && !prevEstimate && prevApprovedHrs === 0 && previousGross !== null && (
                        <span className="block text-[9px] opacity-50">No approved hours recorded for {prevLabel}</span>
                      )}
                    </div>
                    <span className="text-[8px] bg-[#A46832] text-white font-extrabold uppercase px-2.5 py-1 rounded-full tracking-wider inline-block mp-tilt-l">
                      ESTIMATE
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

        {/* HOURLY EARNINGS ESTIMATES — issued by the office and optionally emailed. */}
        <div className="bg-white p-6 mp-blob-l mp-shadow border border-[#EBDECE] space-y-4 text-left">
          <h3 className="font-display text-xs uppercase font-extrabold tracking-widest text-[#A46832]">My Earnings Estimates</h3>
          {employee.payType === 'salary' ? (
            <p className="text-2xs text-[#2E2A26]/55 italic">Salaried employee — actual pay is handled through payroll and is not calculated from timesheet hours in this portal.</p>
          ) : earningsModel.employeePayslips.length === 0 ? (
            <p className="text-2xs text-[#2E2A26]/40 italic">No earnings estimates issued yet. These are gross estimates only, not official payroll documents; PAYE, NI and pension are not calculated here.</p>
          ) : (
            <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
              {earningsModel.employeePayslips.map(p => (
                  <div key={p.id} className="p-3 bg-[#F7EFE6]/70 rounded-xl rounded-tl-sm border border-[#EBDECE] flex justify-between items-center">
                    <div>
                      <span className="text-2xs font-extrabold text-neutral-800 block">{p.periodLabel}</span>
                      <span className="text-[9px] font-mono text-neutral-400">{p.hoursTotal.toFixed(1)} hrs @ £{p.hourlyRate.toFixed(2)} · estimated gross</span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs font-mono font-bold text-emerald-700 block">£{p.gross.toFixed(2)}</span>
                      <span className={`text-[8px] font-black uppercase tracking-wider ${p.status === 'sent' ? 'text-emerald-600' : 'text-amber-500'}`}>
                        {p.status === 'sent' ? `Emailed ${p.sentAt ? new Date(p.sentAt).toLocaleDateString('en-GB', { timeZone: storeTimezone }) : ''}` : 'Issued'}
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* Achievement badges — only real profile data, never fabricated locked counts. */}
        <div className="bg-white p-6 rounded-3xl border border-[#EBDECE] space-y-4">
          <h3 className="font-display text-xs uppercase font-extrabold tracking-widest text-[#A46832]">Achievement Badges</h3>
          {employee.badges.length === 0 ? (
            <p className="text-3xs text-neutral-400 italic">No achievement badges have been awarded yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {employee.badges.map((badge, idx) => (
                <div key={idx} className="bg-gradient-to-br from-[#EBDECE]/20 to-[#A46832]/10 p-3.5 rounded-2xl text-center space-y-1.5 border border-dashed border-[#EBDECE]/50">
                  <span className="text-xl">🌟</span>
                  <h4 className="text-[9px] font-extrabold uppercase text-[#2E2A26] leading-tight tracking-wider">{badge}</h4>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Latest real Knowledge Base guidance. */}
        <div className="bg-white p-6 rounded-3xl border border-[#EBDECE]/50 space-y-4 text-left">
          <h3 className="font-display text-xs uppercase font-extrabold tracking-widest text-[#2E2A26]">Latest operational guidance</h3>
          {articles.length === 0 ? (
            <p className="text-3xs text-neutral-400 italic">No operational guidance has been published.</p>
          ) : (
            <div className="space-y-4">
              {[...articles]
                .sort((a, b) => String(b.lastUpdated).localeCompare(String(a.lastUpdated)))
                .slice(0, 2)
                .map((article) => (
                  <button
                    type="button"
                    key={article.id}
                    onClick={() => setCurrentTab('staff_kb')}
                    className="block w-full border-l-2 border-[#A46832] pl-3 space-y-1 text-left hover:bg-[#F7EFE6]/40 py-1 cursor-pointer"
                  >
                    <span className="text-[9px] text-gray-400 font-mono block">{article.lastUpdated}</span>
                    <h4 className="text-xs font-bold leading-tight">{article.title}</h4>
                    <p className="text-[10px] text-[#2E2A26]/75 leading-relaxed font-light line-clamp-2">{article.content}</p>
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(StaffDashboardPanel);
