import {useSyncExternalStore} from 'react';
import {exactTime, relativeTime} from './relative-time';

// All visible timestamps share one clock. Returning to the tab refreshes it at once.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function tick() {
  now = Date.now();
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    tick();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    }
  };
}
const snapshot = () => now;

export function RelativeTime({value}: {value: string}) {
  const current = useSyncExternalStore(subscribe, snapshot);
  const exact = exactTime(value);
  return <time dateTime={Number.isFinite(Date.parse(value)) ? value : undefined} title={exact} aria-label={exact}>{relativeTime(value, current)}</time>;
}
