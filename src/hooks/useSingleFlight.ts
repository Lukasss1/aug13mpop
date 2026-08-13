import { useCallback, useEffect, useRef, useState } from 'react';

export interface SingleFlightController {
  activeKey: string | null;
  isBusy: boolean;
  run: (key: string, task: () => Promise<void>) => Promise<void>;
}

/**
 * A synchronous single-flight guard for UI mutations.
 *
 * React state alone is not enough to stop two clicks in the same event-loop
 * turn, so the ref is authoritative and state is only the render projection.
 */
export function useSingleFlight(): SingleFlightController {
  const activeRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const run = useCallback(async (key: string, task: () => Promise<void>): Promise<void> => {
    if (activeRef.current) return;
    activeRef.current = key;
    if (mountedRef.current) setActiveKey(key);
    try {
      await task();
    } finally {
      activeRef.current = null;
      if (mountedRef.current) setActiveKey(null);
    }
  }, []);

  return { activeKey, isBusy: activeKey !== null, run };
}
