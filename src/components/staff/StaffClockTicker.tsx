import React, { useEffect, useMemo, useState } from 'react';
import type { ClockStatus } from '../../types';

const FALLBACK_TIMEZONE = 'Europe/London';

function useSecondTicker(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return undefined;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function validTimezone(timezone?: string): string {
  const candidate = timezone || FALLBACK_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

export const StaffClockReadout = React.memo(function StaffClockReadout({ timezone, active = true }: { timezone?: string; active?: boolean }) {
  const now = useSecondTicker(active);
  const zone = useMemo(() => validTimezone(timezone), [timezone]);
  return (
    <>
      <div className="flex items-baseline space-x-2">
        <h1 className="text-4xl font-mono font-extrabold text-[#2E2A26] tracking-tight">
          {now.toLocaleTimeString('en-GB', {
            timeZone: zone,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </h1>
        <span className="text-xs font-mono font-bold text-neutral-400">Store time</span>
      </div>
      <p className="text-xs text-neutral-500 font-medium font-sans">
        {now.toLocaleDateString('en-GB', {
          timeZone: zone,
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })}
      </p>
    </>
  );
});

export const ActiveDutyTimer = React.memo(function ActiveDutyTimer({ clockStatus, active = true }: { clockStatus: ClockStatus; active?: boolean }) {
  const now = useSecondTicker(active);
  const activeMinutes = useMemo(() => {
    if (!clockStatus.clockInTime) return 0;
    const start = new Date(clockStatus.clockInTime).getTime();
    if (!Number.isFinite(start)) return 0;
    const nowMs = now.getTime();
    let breakMs = clockStatus.accumulatedBreakMs || 0;
    if (clockStatus.status === 'on_break' && clockStatus.breakStartTime) {
      const breakStart = new Date(clockStatus.breakStartTime).getTime();
      if (Number.isFinite(breakStart)) breakMs += Math.max(0, nowMs - breakStart);
    }
    return Math.max(0, Math.floor((nowMs - start - breakMs) / 60_000));
  }, [clockStatus, now]);

  return (
    <div className="bg-emerald-50 text-emerald-800 px-3.5 py-2 rounded-xl font-extrabold uppercase tracking-wider text-[10px]">
      Active Duty: {Math.floor(activeMinutes / 60)}h {activeMinutes % 60}m
    </div>
  );
});
