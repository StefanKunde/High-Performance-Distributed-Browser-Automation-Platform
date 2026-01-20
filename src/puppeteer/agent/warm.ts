import { Page } from 'rebrowser-puppeteer';
import { API_ORIGIN } from './constants';

export function startWarmLoop(
  txPage: Page,
  intervalMs: number,
): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      await txPage.evaluate(async (url) => {
        try {
          await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'include',
            keepalive: true,
          });
        } catch {}
      }, API_ORIGIN);
    } catch {}
  }, intervalMs);
  return timer;
}

export function stopWarmLoop(timer: NodeJS.Timeout | null) {
  if (timer) clearInterval(timer);
}
