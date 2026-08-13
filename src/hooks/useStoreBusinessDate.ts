import { useEffect, useState } from 'react';
import { businessTodayISO, msUntilNextBusinessDay } from '../lib/businessDate';

/**
 * Keeps the store calendar date current without a portal-wide clock. It wakes
 * once at the next store-local midnight (DST-safe) instead of polling every
 * minute, and only changes React state when the business date changes.
 */
export function useStoreBusinessDate(timezone?: string): string {
  const [businessDate, setBusinessDate] = useState(() => businessTodayISO(timezone));

  useEffect(() => {
    let timer: number | undefined;
    const refreshAndSchedule = (): void => {
      const next = businessTodayISO(timezone);
      setBusinessDate((current) => current === next ? current : next);
      timer = window.setTimeout(refreshAndSchedule, msUntilNextBusinessDay(timezone));
    };
    refreshAndSchedule();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [timezone]);

  return businessDate;
}
