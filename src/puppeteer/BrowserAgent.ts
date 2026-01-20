import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Page } from 'rebrowser-puppeteer';
import { GRAPHQL_URL, SITE_URL, CHROME_ARGS } from './agent/constants';
import { ensureProfileUnlocked } from './agent/profile';
import { attachDataMonitor } from './agent/dataMonitor';
import {
  buildUserCookieHeader,
  readAuthCookies,
  type AuthCookies,
} from './agent/cookies';
import { connect } from 'puppeteer-real-browser';
import { SessionTokenGenerator } from './agent/tokenGenerator';

export type BrowserAgentOptions = {
  session: string;
  userAgent?: string;
  profileDirRoot?: string;
  headful?: boolean;
  warmIntervalMs?: number;
  navigationTimeoutMs?: number;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
    bypassList?: string;
  };
};

puppeteer.use(StealthPlugin());

/**
 * Browser session manager for distributed data processing
 * Manages browser lifecycle, session state, and network monitoring
 */
export class BrowserAgent extends EventEmitter {
  private readonly opts: Required<Omit<BrowserAgentOptions, 'proxy'>> & {
    proxy?: BrowserAgentOptions['proxy'];
  };
  private browser: import('puppeteer').Browser | null = null;
  private page!: Page;
  private warmTimer: NodeJS.Timeout | null = null;

  private lastBalance: number | null = null;
  private lastAuthCookies: AuthCookies = {};
  private lastCookieHeader: string | null = null;
  private lastAuthCookieHeader: string | null = null;
  private cookieRefreshTimer: NodeJS.Timeout | null = null;
  private sessionPage!: Page;
  private metadataEmitted = false;
  private lastMetadata: {
    id?: string;
    name?: string;
    version?: string;
    at?: number;
  } | null = null;
  private metadataSniffDone = false;
  private metadataWaiters: Array<
    (m: { id?: string; name?: string; version?: string; at?: number }) => void
  > = [];
  private metadataCleanup: Array<() => void> = [];

  private isStarted = false;
  private tokenGenerator: SessionTokenGenerator | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;

  /**
   * Creates a new BrowserAgent instance with the specified configuration options
   * Sets default values for user agent, profile directory, timeouts, and proxy settings
   * @param options Configuration options for the browser agent
   */
  constructor(options: BrowserAgentOptions) {
    super();
    this.opts = {
      userAgent:
        options.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      headful: options.headful ?? true,
      profileDirRoot:
        options.profileDirRoot || path.join(os.tmpdir(), 'browser-profiles'),
      warmIntervalMs: options.warmIntervalMs ?? 10_000,
      navigationTimeoutMs: options.navigationTimeoutMs ?? 15_000,
      session: options.session,
      proxy: options.proxy,
    };
  }

  /**
   * Initialize browser and establish session
   * Launches the browser with stealth plugins, sets up cookie monitoring,
   * configures proxy authentication, and initializes token generation
   * Sets up signal handlers for graceful shutdown
   * @throws Error if browser initialization fails
   */
  public async start(): Promise<void> {
    if (this.isStarted) return;

    const userDataDir = path.join(
      this.opts.profileDirRoot,
      `session-${this.opts.session}`,
    );

    try {
      await ensureProfileUnlocked(userDataDir);

      const { browser, page } = await connect({
        headless: !this.opts.headful,
        args: this.getLaunchArgs(),
        turnstile: true,
        disableXvfb: false,
        customConfig: {
          chromePath: '/usr/bin/google-chrome-stable',
          userDataDir,
        },
        connectOption: {
          defaultViewport: null,
        },
      });
      this.browser = browser as any;
      this.attachProxyAuthAutoHook();

      const pages = await this.browser?.pages();
      this.page = (pages![0] || (await this.browser!.newPage())) as any as Page;
      await this.applyProxyAuth(this.page);
      await this.forceUAOnPage(this.page, this.opts.userAgent);
      this.page.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs);

      try {
        const realUA = await this.browser!.userAgent();
        const isDefault = /Chrome\/123\.0\.0\.0/.test(
          this.opts.userAgent || '',
        );
        if (realUA && isDefault) {
          this.opts.userAgent = realUA;
          await this.page.setUserAgent(realUA).catch(() => {});
        } else {
          await this.page.setUserAgent(this.opts.userAgent).catch(() => {});
        }
      } catch {}

      try {
        await this.page.setBypassServiceWorker(true);
      } catch {}
      await this.prepareNetMonitoring(this.page);

      await attachDataMonitor(this.page, (data) => {
        this.emit('dataUpdate', data);
      });

      await this.setUserSessionCookie(this.page, this.opts.session);
      await this.safeGoto(this.page, SITE_URL);

      {
        const { header, map, count } = await buildUserCookieHeader(this.page);
        if (header && header !== this.lastCookieHeader) {
          this.lastCookieHeader = header;
          this.emit('cookies', {
            header,
            map,
            count,
            reason: 'initial',
            updatedAt: Date.now(),
          });
        }
      }

      {
        const { cookies, header, count } = await readAuthCookies(this.page);
        this.lastAuthCookies = cookies;
        if (header && header !== this.lastAuthCookieHeader) {
          this.lastAuthCookieHeader = header;
          this.emit('authCookies', {
            header,
            map: { ...this.lastAuthCookies },
            count,
            reason: 'initial',
            updatedAt: Date.now(),
          });
        }
      }

      this.sessionPage = (await this.browser!.newPage()) as any as Page;
      await this.applyProxyAuth(this.sessionPage);
      await this.forceUAOnPage(this.sessionPage, this.opts.userAgent);
      this.sessionPage.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs);
      await this.applyUserAgent(this.sessionPage);
      try {
        await this.sessionPage.setBypassServiceWorker(true);
      } catch {}

      await this.safeGoto(this.sessionPage, SITE_URL);
      await this.prepareNetMonitoring(this.sessionPage);

      this.tokenGenerator = new SessionTokenGenerator(this.sessionPage);

      this.tokenRefreshTimer = setInterval(
        async () => {
          if (this.tokenGenerator) {
            try {
              await this.tokenGenerator.ensureWarm();
            } catch (e: any) {
              console.error('[Token] Refresh failed:', e?.message || e);
            }
          }
        },
        70_000,
      );
      this.tokenRefreshTimer.unref?.();

      (async () => {
        try {
          await this.tokenGenerator!.getToken();
        } catch (e: any) {
          console.error('[Token] Initial generation failed:', e?.message || e);
        }
      })();

      if (this.cookieRefreshTimer) clearInterval(this.cookieRefreshTimer);
      this.cookieRefreshTimer = setInterval(async () => {
        try {
          await this.page.reload({ waitUntil: 'domcontentloaded' });
          const { header, map, count } = await buildUserCookieHeader(this.page);
          if (header && header !== this.lastCookieHeader) {
            this.lastCookieHeader = header;
            this.emit('cookies', {
              header,
              map,
              count,
              reason: 'periodic-refresh',
              updatedAt: Date.now(),
            });
          }
        } catch (e: any) {
          console.warn('[cookies] Periodic reload failed:', e?.message || e);
        }
      }, 119_000);

      this.isStarted = true;

      const onSig = async (sig: string) => {
        try {
          await this.close();
        } catch {}
        process.exit(sig === 'SIGINT' ? 130 : 0);
      };
      process.once('SIGINT', () => onSig('SIGINT'));
      process.once('SIGTERM', () => onSig('SIGTERM'));
      process.once('uncaughtException', async (err) => {
        console.error('[fatal]', err?.message || err);
        try {
          await this.close();
        } catch {}
        process.exit(1);
      });
    } catch (err: any) {
      this.isStarted = false;
      await this.close().catch(() => {});
      throw new Error(`session-start-failed: ${err?.message || String(err)}`);
    }
  }

  /**
   * Gracefully shuts down the browser session
   * Clears all timers, resets token generator, closes browser instance,
   * and kills the browser process if still running
   */
  public async close(): Promise<void> {
    if (this.warmTimer) {
      clearInterval(this.warmTimer);
      this.warmTimer = null;
    }

    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    if (this.tokenGenerator) {
      this.tokenGenerator.reset();
      this.tokenGenerator = null;
    }

    try {
      await this.browser?.close();
    } catch {}

    try {
      const p = this.browser!.process?.();
      if (p) {
        p.kill('SIGKILL');
      }
    } catch {}

    if (this.cookieRefreshTimer) {
      clearInterval(this.cookieRefreshTimer);
      this.cookieRefreshTimer = null;
    }

    this.browser = null;
    this.isStarted = false;
  }

  /**
   * Returns a copy of the current authentication cookies
   * @returns Object containing authentication cookie key-value pairs
   */
  public getAuthCookies(): AuthCookies {
    return { ...this.lastAuthCookies };
  }

  /**
   * Returns the last known balance value
   * @returns The balance as a number or null if not set
   */
  public getBalance(): number | null {
    return this.lastBalance;
  }

  /**
   * Returns the current user cookie header string
   * @returns The cookie header string or null if not set
   */
  public getUserCookieHeader(): string | null {
    return this.lastCookieHeader;
  }

  /**
   * Returns the current authentication cookie header string
   * @returns The auth cookie header string or null if not set
   */
  public getAuthCookieHeader(): string | null {
    return this.lastAuthCookieHeader;
  }

  /**
   * Returns the main browser page instance
   * @returns The Puppeteer Page object or null if not initialized
   */
  public getPage(): Page | null {
    return this.page;
  }

  /**
   * Reloads the main page or navigates to the site URL based on current location
   * If on the API domain or localhost, performs a page reload
   * Otherwise navigates to the site URL
   * Waits 3 seconds after reload/navigation for page stabilization
   * @throws Error if page is not initialized
   */
  public async reloadMainPage(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const currentUrl = this.page.url();
    const apiDomain = process.env.API_DOMAIN || 'api.example-service.local';
    if (currentUrl.includes(apiDomain) || currentUrl.includes('localhost')) {
      await this.page
        .reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch((e) => {
          console.error('[agent] Reload failed:', e.message);
        });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else {
      await this.safeGoto(this.page, SITE_URL);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  /**
   * Applies the configured user agent string to the specified page
   * @param p The page to apply the user agent to
   */
  private async applyUserAgent(p: Page) {
    if (this.opts.userAgent) {
      await p.setUserAgent(this.opts.userAgent);
    }
  }

  /**
   * Safely navigates to a URL, suppressing any navigation errors
   * Waits until DOM content is loaded before continuing
   * @param p The page to navigate
   * @param url The URL to navigate to
   */
  public async safeGoto(p: Page, url: string) {
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded' });
    } catch {}
  }

  /**
   * Sets the session cookie on the specified page
   * Uses the API domain for the cookie scope
   * @param p The page to set the cookie on
   * @param session The session value to set
   * @throws Error if setting the cookie fails
   */
  private async setUserSessionCookie(p: Page, session: string) {
    const cookie = {
      name: 'session',
      value: session,
      domain: '.api.example-service.local',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    };
    try {
      await p.setCookie(cookie);
    } catch (e: any) {
      throw new Error(`set-session-cookie-failed: ${e?.message || e}`);
    }
  }

  /**
   * Sets up network monitoring on the specified page
   * Monitors GraphQL requests/responses for client metadata
   * Captures apollographql client headers (id, name, version)
   * Emits events for GraphQL responses and metadata discovery
   * @param p The page to attach network monitoring to
   */
  private async prepareNetMonitoring(p: Page) {
    const registerMetadataCleanup = (fn: () => void) =>
      this.metadataCleanup.push(fn);

    try {
      try {
        await p.setBypassServiceWorker(true);
      } catch {}

      const root = await (p as any).target().createCDPSession();
      await root
        .send('Network.enable', { maxTotalBufferSize: 1024 * 1024 })
        .catch(() => {});

      try {
        const metaById = new Map<string, any>();
        const urlById = new Map<string, string>();

        const tryEmit = (rid: string) => {
          if (this.metadataSniffDone) return;
          const meta = metaById.get(rid);
          let url = urlById.get(rid) || '';
          if (!meta) return;

          if (!url && meta._h2?.authority && meta._h2?.path) {
            const scheme = meta._h2.scheme || 'https';
            url = `${scheme}://${meta._h2.authority}${meta._h2.path}`;
          }
          const looksLikeGql =
            url.startsWith(GRAPHQL_URL) ||
            (meta._h2?.authority === 'router.api.example-service.local' &&
              (meta._h2?.path || '').startsWith('/graphql'));
          if (!looksLikeGql) return;

          if (meta.id || meta.name || meta.version) {
            this.handleMetadataFound({
              id: meta.id || undefined,
              name: meta.name || undefined,
              version: meta.version || undefined,
              at: meta.at || Date.now(),
            });
            metaById.delete(rid);
            urlById.delete(rid);
          }
        };

        const onExtra = (e: any) => {
          try {
            if (this.metadataSniffDone) return;
            const h = (e?.headers ?? {}) as Record<string, string>;

            const meta: any = {
              id:
                (
                  h['apollographql-client-id'] ||
                  h['Apollographql-Client-Id'] ||
                  ''
                ).toString() || undefined,
              name:
                (
                  h['apollographql-client-name'] ||
                  h['Apollographql-Client-Name'] ||
                  ''
                ).toString() || undefined,
              version:
                (
                  h['apollographql-client-version'] ||
                  h['Apollographql-Client-Version'] ||
                  ''
                ).toString() || undefined,
              at: Date.now(),
            };

            const authority = (h[':authority'] || '').toString();
            const path = (h[':path'] || '').toString();
            const scheme = (h[':scheme'] || 'https').toString();
            if (authority || path) meta._h2 = { authority, path, scheme };

            metaById.set(e.requestId, meta);
            tryEmit(e.requestId);
          } catch {}
        };

        const onSent = (e: any) => {
          try {
            if (this.metadataSniffDone) return;
            const url: string = e?.request?.url || '';
            if (url) urlById.set(e.requestId, url);
            tryEmit(e.requestId);
          } catch {}
        };

        root.on('Network.requestWillBeSentExtraInfo', onExtra);
        root.on('Network.requestWillBeSent', onSent);

        registerMetadataCleanup(() => {
          try {
            root.off('Network.requestWillBeSentExtraInfo', onExtra);
          } catch {}
          try {
            root.off('Network.requestWillBeSent', onSent);
          } catch {}
        });
      } catch {}
    } catch {}

    p.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (!url.startsWith(GRAPHQL_URL)) return;

        const status = resp.status();
        if (status < 200 || status >= 300) return;

        let text = '';
        try {
          text = await resp.text();
        } catch {
          return;
        }
        if (!text || text[0] !== '{') return;

        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          return;
        }

        this.emit('graphqlResponse', data);
      } catch {}
    });

    const onReq = (req: import('puppeteer').HTTPRequest) => {
      try {
        if (this.metadataSniffDone) return;
        const url = req.url();
        if (!url.startsWith(GRAPHQL_URL)) return;

        const method = (req.method() || '').toUpperCase();
        if (method === 'OPTIONS' || req.resourceType() === 'preflight') return;

        const h = req.headers();
        const clientId = (h['apollographql-client-id'] ?? '').toString();
        const clientName = (h['apollographql-client-name'] ?? '').toString();
        const clientVersion = (
          h['apollographql-client-version'] ?? ''
        ).toString();

        if (clientId || clientName || clientVersion) {
          this.handleMetadataFound({
            id: clientId || undefined,
            name: clientName || undefined,
            version: clientVersion || undefined,
            at: Date.now(),
          });
        }
      } catch {}
    };
    p.on('request', onReq);
    registerMetadataCleanup(() => {
      try {
        p.off('request', onReq);
      } catch {}
    });
  }

  /**
   * Returns a copy of the last captured client metadata
   * Metadata includes apollographql client id, name, version, and timestamp
   * @returns Object with metadata fields or null if not yet captured
   */
  public getMetadata(): {
    id?: string;
    name?: string;
    version?: string;
    at?: number;
  } | null {
    return this.lastMetadata ? { ...this.lastMetadata } : null;
  }

  /**
   * Waits for client metadata to be captured from network traffic
   * Returns immediately if metadata is already available
   * @param timeoutMs Maximum time to wait in milliseconds, defaults to 10 seconds
   * @returns Promise resolving to metadata object
   * @throws Error if metadata is not captured within the timeout period
   */
  public async waitForMetadata(
    timeoutMs = 10_000,
  ): Promise<{ id?: string; name?: string; version?: string; at?: number }> {
    if (this.lastMetadata) return { ...this.lastMetadata };
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (m: {
        id?: string;
        name?: string;
        version?: string;
        at?: number;
      }) => {
        if (settled) return;
        settled = true;
        resolve(m);
      };
      const timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          reject(new Error('metadata-timeout'));
        },
        Math.max(1, timeoutMs),
      );

      this.metadataWaiters.push((m) => {
        clearTimeout(timer);
        done(m);
      });
    });
  }

  /**
   * Handles the discovery of client metadata from network traffic
   * Marks metadata sniffing as complete, stores metadata, emits event,
   * cleans up network listeners, and resolves any pending waiters
   * Only processes the first metadata found, ignores subsequent calls
   * @param meta The discovered metadata object
   */
  private handleMetadataFound(meta: {
    id?: string;
    name?: string;
    version?: string;
    at?: number;
  }) {
    if (this.metadataSniffDone) return;
    this.metadataSniffDone = true;
    this.lastMetadata = meta;
    try {
      this.emit('metadata', meta);
    } catch {}
    for (const fn of this.metadataCleanup) {
      try {
        fn();
      } catch {}
    }
    this.metadataCleanup = [];
    for (const w of this.metadataWaiters) {
      try {
        w(meta);
      } catch {}
    }
    this.metadataWaiters = [];
  }

  /**
   * Returns the current URL of the main page
   * Falls back to the default site URL if unable to get current URL
   * @returns The current page URL as a string
   */
  public getCurrentUrl(): string {
    try {
      return this.page?.url() || 'https://www.api.example-service.local/';
    } catch {
      return 'https://www.api.example-service.local/';
    }
  }

  /**
   * Extracts the platform name from a user agent string
   * Detects Windows, macOS, Android, or Linux based on UA patterns
   * @param ua The user agent string to parse
   * @returns Platform name or empty string if not detected
   */
  private derivePlatformFromUA(ua: string): string {
    if (/Windows NT/i.test(ua)) return 'Windows';
    if (/Mac OS X/i.test(ua)) return 'macOS';
    if (/Android/i.test(ua)) return 'Android';
    if (/Linux/i.test(ua)) return 'Linux';
    return '';
  }

  /**
   * Extracts the Chrome major version number from a user agent string
   * @param ua The user agent string to parse
   * @returns The major version number as a string, or '0' if not found
   */
  private parseChromeMajor(ua: string): string {
    const m = ua.match(/Chrome\/(\d+)/i);
    return m ? m[1] : '0';
  }

  /**
   * Builds client hints metadata object from a user agent string
   * Constructs brand lists, platform info, and version data for Chromium-based browsers
   * @param ua The user agent string to build metadata from
   * @returns Object containing user agent client hints metadata
   */
  private buildUAMetadata(ua: string) {
    const major = this.parseChromeMajor(ua);
    return {
      brands: [
        { brand: 'Not/A)Brand', version: '8' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
      ],
      fullVersionList: [
        { brand: 'Not/A)Brand', version: '8.0.0.0' },
        { brand: 'Chromium', version: `${major}.0.0.0` },
        { brand: 'Google Chrome', version: `${major}.0.0.0` },
      ],
      platform: this.derivePlatformFromUA(ua) || 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      bitness: '64',
      mobile: false,
    };
  }

  /**
   * Forces a specific user agent on a page using both standard API and CDP
   * Sets user agent via Puppeteer API and Chrome DevTools Protocol
   * Also configures user agent metadata (client hints) and language headers
   * @param p The page to configure
   * @param ua The user agent string to set
   */
  private async forceUAOnPage(p: Page, ua: string) {
    if (!p || !ua) return;
    await p.setUserAgent(ua).catch(() => {});
    try {
      const cdp = await (p as any).target().createCDPSession();
      await cdp
        .send('Network.setUserAgentOverride', {
          userAgent: ua,
          platform: this.derivePlatformFromUA(ua),
          acceptLanguage: 'en-US,en;q=0.9',
          userAgentMetadata: this.buildUAMetadata(ua),
        })
        .catch(() => {});
    } catch {}
    await p
      .setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
      .catch(() => {});
  }

  /**
   * Updates the user agent for all active pages
   * Applies the new user agent to both main page and session page
   * @param ua The new user agent string to use
   */
  public async setPreferredUserAgent(ua: string): Promise<void> {
    if (!ua) return;
    this.opts.userAgent = ua;
    const pages: Page[] = [this.page, this.sessionPage].filter(Boolean) as Page[];
    await Promise.all(pages.map((p) => this.forceUAOnPage(p, ua)));
  }

  /**
   * Builds the Chrome launch arguments array
   * Includes base Chrome arguments and adds proxy configuration if specified
   * Disables IPv6 when no proxy is configured
   * @returns Array of command line arguments for Chrome
   */
  private getLaunchArgs(): string[] {
    const args = [...CHROME_ARGS];
    if (this.opts.proxy?.server) {
      args.push(`--proxy-server=${this.opts.proxy.server}`);
      args.push(
        `--proxy-bypass-list=${this.opts.proxy.bypassList ?? '<-loopback>'}`,
      );
    } else {
      args.push('--disable-features=IPv6');
    }
    return args;
  }

  /**
   * Applies proxy authentication credentials to a page
   * Authenticates with proxy using username and password if configured
   * @param p The page to apply proxy authentication to
   */
  private async applyProxyAuth(p: Page) {
    if (this.opts.proxy?.username) {
      try {
        await p.authenticate({
          username: this.opts.proxy.username,
          password: this.opts.proxy.password ?? '',
        });
      } catch (e: any) {
        console.warn('[proxy] Auth failed:', e?.message || e);
      }
    }
  }

  /**
   * Attaches a hook to automatically apply proxy authentication to new browser targets
   * Listens for new page/tab creation and applies proxy credentials automatically
   */
  private attachProxyAuthAutoHook() {
    if (!this.browser) return;
    this.browser.on('targetcreated', async (t) => {
      try {
        const p = await t.page();
        if (p) await this.applyProxyAuth(p);
      } catch {}
    });
  }

  /**
   * Gets a valid session token from the token generator
   * Can optionally force generation of a new token
   * @param forceNew If true, forces generation of a new token instead of using cached one
   * @returns Promise resolving to the session token string
   * @throws Error if token generator is not initialized
   */
  public async getSessionToken(forceNew: boolean = false): Promise<string> {
    if (!this.tokenGenerator) {
      throw new Error('[Token] Generator not initialized');
    }

    return await this.tokenGenerator.getToken(forceNew);
  }

  /**
   * Gets the age of the current session token in milliseconds
   * Returns how long ago the current token was generated
   * @returns Age in milliseconds or null if token generator is not initialized
   */
  public getTokenAge(): number | null {
    return this.tokenGenerator?.getTokenAge() ?? null;
  }
}
