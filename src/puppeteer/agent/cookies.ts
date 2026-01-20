import { Page, Browser, Protocol } from 'rebrowser-puppeteer';
import { SITE_URL } from './constants';

// Generic auth token cookies used by most web services
export type AuthCookies = { auth_token?: string; session_token?: string };

export async function getAllCookiesMap(
  p: Page,
): Promise<Record<string, string>> {
  const client = await (p as any).target().createCDPSession();
  try {
    await client.send('Network.enable', { maxTotalBufferSize: 128 * 1024 });
  } catch {}
  const all = await client.send('Network.getAllCookies').catch(() => null);
  const list: Array<{ name: string; value: string }> = all?.cookies ?? [];
  return Object.fromEntries(list.map((c) => [c.name, c.value]));
}

export async function buildUserCookieHeader(p: Page): Promise<{
  header: string;
  map: Record<string, string>;
  count: number;
}> {
  const url = p.url();
  const apiDomain = process.env.API_DOMAIN || 'api.example-service.local';
  if (!url.includes(apiDomain) && !url.includes('localhost')) {
    try {
      await p.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
    } catch {}
  }
  const list = await p.cookies();
  const map: Record<string, string> = {};
  const pairs: string[] = [];
  for (const c of list) {
    if (!c || !c.name) continue;
    map[c.name] = c.value ?? '';
    pairs.push(`${c.name}=${c.value ?? ''}`);
  }
  const header = pairs.join('; ');
  return { header, map, count: list.length };
}

export async function readAuthCookies(p: Page): Promise<{
  cookies: AuthCookies;
  header: string;
  count: number;
}> {
  const map = await getAllCookiesMap(p);
  const auth_token = map['auth_token'];
  const session_token = map['session_token'];
  const pairs: string[] = [];
  if (auth_token) pairs.push(`auth_token=${auth_token}`);
  if (session_token) pairs.push(`session_token=${session_token}`);
  return {
    cookies: { auth_token, session_token },
    header: pairs.join('; '),
    count: pairs.length,
  };
}

export async function importCookiesTo(page: Page, cookies: AuthCookies) {
  try {
    const toSet: Array<Protocol.Network.CookieParam> = [];
    const apiCookieDomain =
      process.env.API_COOKIE_DOMAIN || '.example-service.local';

    if (cookies.auth_token) {
      toSet.push({
        name: 'auth_token',
        value: cookies.auth_token,
        domain: apiCookieDomain,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      });
    }
    if (cookies.session_token) {
      toSet.push({
        name: 'session_token',
        value: cookies.session_token,
        domain: apiCookieDomain,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      });
    }
    if (toSet.length)
      await (page as any)
        ._client()
        .send('Network.setCookies', { cookies: toSet });
  } catch {}
}

export async function touchApiOnce(p: Page) {
  try {
    const apiOrigin =
      process.env.API_ORIGIN || 'https://api.example-service.local';
    await p.evaluate(async (origin) => {
      try {
        await fetch(origin, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          keepalive: true,
          mode: 'cors',
        });
      } catch {}
    }, apiOrigin);
  } catch {}
}

export async function waitForAuthCookies(
  p: Page,
  totalWaitMs: number,
): Promise<AuthCookies> {
  const tEnd = Date.now() + totalWaitMs;
  let seen: AuthCookies = {};
  let client: any = null;
  try {
    client = await (p as any).target().createCDPSession();
    try {
      await client.send('Network.enable', { maxTotalBufferSize: 256 * 1024 });
    } catch {}
  } catch {}

  while (Date.now() < tEnd) {
    try {
      if (client) {
        const all = await client
          .send('Network.getAllCookies')
          .catch(() => null);
        const list: Array<{ name: string; value: string }> = all?.cookies ?? [];
        const map = Object.fromEntries(list.map((c) => [c.name, c.value]));
        seen = {
          auth_token: map['auth_token'],
          session_token: map['session_token'],
        };
      } else {
        const siteUrl =
          process.env.SITE_URL || 'https://app.example-service.local/';
        const list = await p.cookies(siteUrl);
        const map = Object.fromEntries(list.map((c) => [c.name, c.value]));
        seen = {
          auth_token: map['auth_token'],
          session_token: map['session_token'],
        };
      }
      if (seen.auth_token || seen.session_token) return seen;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return seen;
}

export async function ensureAuthCookiesForHost(
  browser: Browser,
  hostUrl: string,
  waitMs = 15000,
): Promise<AuthCookies> {
  let tab: Page | null = null;
  try {
    tab = await browser.newPage();
    tab.setDefaultNavigationTimeout(Math.max(waitMs, 15000));
    try {
      await tab.setBypassServiceWorker(true);
    } catch {}
    try {
      await tab.goto(hostUrl, {
        waitUntil: 'domcontentloaded',
        timeout: waitMs,
      });
    } catch {}
    try {
      // Generic endpoint for protocol compliance check
      await tab.goto(new URL('/health', hostUrl).toString(), {
        waitUntil: 'domcontentloaded',
        timeout: waitMs,
      });
    } catch {}
    const auth = await waitForAuthCookies(tab, waitMs);
    return auth;
  } catch {
    return {};
  } finally {
    try {
      await tab?.close();
    } catch {}
  }
}
