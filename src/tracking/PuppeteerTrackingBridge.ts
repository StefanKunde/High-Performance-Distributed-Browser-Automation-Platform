/**
 * PuppeteerTrackingBridge - Bridges Puppeteer events to TrackingManager
 *
 * Responsibilities:
 * 1. Listen to WebSocket frames for trade updates
 * 2. Intercept network requests for initial user data
 * 3. Forward events to TrackingManager
 */

import { Page } from 'rebrowser-puppeteer-core';
import { TrackingManager } from './TrackingManager';

export class PuppeteerTrackingBridge {
  private page: Page | null = null;
  private trackingManager: TrackingManager;
  private wsListenerAttached = false;
  private networkListenerAttached = false;
  private userDataSnapshotSent = false; // Track if user-data was already sent
  private fetchingTradeHistory = false; // Track if we're currently fetching trade history
  private periodicFetchInterval: NodeJS.Timeout | null = null; // Periodic fetch interval
  private lastSeenTradeIds = new Set<string>(); // Track trades we've already sent
  private initialDataCollected = {
    currentUser: false,
    instantPayout: false,
    escrowBracket: false,
    exchangeRates: false,
    tradeHistory: false,
  };

  constructor(trackingManager: TrackingManager) {
    this.trackingManager = trackingManager;
  }

  /**
   * Attach to Puppeteer page
   */
  public async attach(page: Page): Promise<void> {
    this.page = page;

    // Attach WebSocket listener
    await this.attachWebSocketListener();

    // Attach network request interceptor
    await this.attachNetworkListener();

    // Ensure userId is captured with retry logic (non-blocking)
    // Once userId is captured, fetch trade history
    this.ensureUserIdCaptured()
      .then(async () => {
        // After userId captured, fetch trade history
        await this.fetchTradeHistory();

        // Start periodic fetch every 15 minutes
        this.startPeriodicTradeHistoryFetch();
      })
      .catch((err) => {
        console.error(
          '[PuppeteerTrackingBridge] ensureUserIdCaptured failed:',
          err.message,
        );
      });

  }

  /**
   * Detach from page
   */
  public detach(): void {
    this.page = null;
    this.wsListenerAttached = false;
    this.networkListenerAttached = false;

    // Clear periodic fetch interval
    if (this.periodicFetchInterval) {
      clearInterval(this.periodicFetchInterval);
      this.periodicFetchInterval = null;
    }

  }

  /**
   * Attach WebSocket frame listener
   */
  private async attachWebSocketListener(): Promise<void> {
    if (!this.page || this.wsListenerAttached) return;

    try {
      const client = await this.page.target().createCDPSession();

      // Enable network domain
      await client.send('Network.enable');

      // Listen for WebSocket frames
      client.on('Network.webSocketFrameReceived', (evt: any) => {
        this.handleWebSocketFrame(evt);
      });

      this.wsListenerAttached = true;
    } catch (err: any) {
      console.error(
        '[PuppeteerTrackingBridge] Failed to attach WS listener:',
        err.message,
      );
    }
  }

  /**
   * Attach network request interceptor
   */
  private async attachNetworkListener(): Promise<void> {
    if (!this.page || this.networkListenerAttached) return;

    try {
      // Use both CDP and Puppeteer's response event for maximum compatibility
      const client = await this.page.target().createCDPSession();
      await client.send('Network.enable').catch(() => {});

      // Use Puppeteer's response event
      this.page.on('response', async (response) => {
        await this.handlePuppeteerResponse(response);
      });

      this.networkListenerAttached = true;
    } catch (err: any) {
      console.error(
        '[PuppeteerTrackingBridge] Failed to attach network listener:',
        err.message,
      );
    }
  }

  /**
   * Ensure userId is captured with retry logic (non-blocking, 2 quick retries)
   */
  private async ensureUserIdCaptured(): Promise<void> {
    const maxRetries = 2;
    const initialDelayMs = 2000; // 2 seconds initial wait
    const retryDelayMs = 3000; // 3 seconds between retries

    // Initial wait for CurrentUser request
    await new Promise((resolve) => setTimeout(resolve, initialDelayMs));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const snapshot = this.trackingManager.getUserDataSnapshot();
      if (snapshot && snapshot.userId) {
        console.log(
          `[PuppeteerTrackingBridge] ✅ userId captured: ${snapshot.userId}`,
        );
        return;
      }

      console.warn(
        `[PuppeteerTrackingBridge] Attempt ${attempt}/${maxRetries}: userId not yet captured`,
      );

      // If not the last attempt, reload the page
      if (attempt < maxRetries && this.page) {
        console.log(
          `[PuppeteerTrackingBridge] Reloading page to retry userId capture...`,
        );
        try {
          await this.page.reload({ waitUntil: 'networkidle2', timeout: 15000 });
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        } catch (err: any) {
          console.error(
            `[PuppeteerTrackingBridge] Page reload failed:`,
            err.message,
          );
        }
      }
    }

    console.error(
      `[PuppeteerTrackingBridge] ❌ Failed to capture userId after ${maxRetries} attempts - tracking will be limited until userId is available`,
    );
  }

  /**
   * Handle WebSocket frame
   */
  private handleWebSocketFrame(evt: any): void {
    try {
      const frame = evt?.response?.payloadData;
      if (!frame) return;

      const data = JSON.parse(frame);

      // Check if this is a trade update (updateTrade subscription)
      if (data?.type === 'next' && data?.payload?.data?.updateTrade) {
        this.trackingManager.handleTradeUpdate(data.payload);
      }
    } catch (err: any) {
      // Silently ignore parse errors (many WS frames are not JSON or not relevant)
    }
  }

  /**
   * Handle Puppeteer response
   */
  private async handlePuppeteerResponse(response: any): Promise<void> {
    try {
      const url = response.url();
      if (!url || !url.includes('router.api.example-service.local/graphql')) return;

      const method = response.request().method();
      const status = response.status();

      // Skip preflight requests
      if (method === 'OPTIONS') return;

      // Only process successful responses
      if (status !== 200) return;

      // Extract operation name from URL
      let operationName = '';
      try {
        const urlObj = new URL(url);
        operationName = urlObj.searchParams.get('operationName') || '';
      } catch (err: any) {
        // Silently ignore parse errors
      }

      // Skip TradeTable if we're currently fetching trade history (separate listener handles it)
      if (operationName === 'TradeTable' && this.fetchingTradeHistory) {
        return;
      }

      // Only intercept initial data requests (once each)
      if (
        operationName === 'CurrentUser' &&
        !this.initialDataCollected.currentUser
      ) {
        const success = await this.interceptCurrentUser(response);
        if (success) {
          this.initialDataCollected.currentUser = true;
        }
      } else if (
        operationName === 'GetUserRemainingInstantPayoutAmount' &&
        !this.initialDataCollected.instantPayout
      ) {
        await this.interceptInstantPayout(response);
        this.initialDataCollected.instantPayout = true;
      } else if (
        operationName === 'CurrentUserTradeEscrowBracket' &&
        !this.initialDataCollected.escrowBracket
      ) {
        await this.interceptEscrowBracket(response);
        this.initialDataCollected.escrowBracket = true;
      } else if (
        operationName === 'ExchangeRates' &&
        !this.initialDataCollected.exchangeRates
      ) {
        await this.interceptExchangeRates(response);
        this.initialDataCollected.exchangeRates = true;
      }

      // Check if all initial data collected and not yet sent
      if (this.allInitialDataCollected() && !this.userDataSnapshotSent) {
        // Send user data snapshot to backend
        await this.trackingManager.sendUserDataSnapshot();
        this.userDataSnapshotSent = true;
      }
    } catch (err: any) {
      console.error('[PuppeteerTrackingBridge] Error in handlePuppeteerResponse:', err.message, err.stack);
    }
  }

  /**
   * Intercept CurrentUser response
   * @returns true if successfully captured userId, false otherwise
   */
  private async interceptCurrentUser(response: any): Promise<boolean> {
    try {
      const text = await response.text();
      if (!text) return false;

      const data = JSON.parse(text);
      const user = data?.data?.currentUser;

      // Only accept responses that have a valid userId
      if (!user || !user.id) return false;

      // Get display name (could be 'name' or 'displayName' depending on endpoint)
      const displayName = user.name || user.displayName || '';

      // Extract main wallet coins (may not be present in this endpoint)
      const mainWallet = user.wallets?.find((w: any) => w.name === 'MAIN');
      const coins = mainWallet?.amount || 0;

      // Extract exchange rates (if available in this response - otherwise we'll get it separately)
      const eurRate =
        user.exchangeRates?.rates?.find((r: any) => r.currency === 'EUR')
          ?.rate || 0;
      const usdRate =
        user.exchangeRates?.rates?.find((r: any) => r.currency === 'USD')
          ?.rate || 0;

      // Extract level and xp
      const level = user.level || user.userProgress?.level || 0;
      const xp = user.xp || user.userProgress?.xp || 0;

      this.trackingManager.setUserDataSnapshot({
        userId: user.id,
        displayName,
        email: user.email || null,
        steamId: user.steamId || '',
        level,
        xp,
        coins,
        suspectedTrader: user.suspectedTrader || false,
        tradeBannedUntil: user.tradeBannedUntil || user.mutedUntil || null,
        bannedUntil: user.bannedUntil || null,
        exchangeRates: { EUR: eurRate, USD: usdRate },
      });

      return true;
    } catch (err: any) {
      console.error(
        '[PuppeteerTrackingBridge] Error intercepting CurrentUser:',
        err.message,
      );
      return false;
    }
  }

  /**
   * Intercept GetUserRemainingInstantPayoutAmount response
   */
  private async interceptInstantPayout(response: any): Promise<void> {
    try {
      const text = await response.text();
      if (!text) return;

      const data = JSON.parse(text);
      const amount =
        data?.data?.getUserRemainingInstantPayoutAmount
          ?.remainingInstantPayoutAmount;

      if (amount !== undefined) {
        this.trackingManager.setUserDataSnapshot({
          remainingInstantPayoutAmount: amount,
        });
      }
    } catch (err: any) {
      console.error(
        '[PuppeteerTrackingBridge] Error intercepting InstantPayout:',
        err.message,
      );
    }
  }

  /**
   * Intercept CurrentUserTradeEscrowBracket response
   */
  private async interceptEscrowBracket(response: any): Promise<void> {
    try {
      const text = await response.text();
      if (!text) return;

      const data = JSON.parse(text);
      const weeklyLimit =
        data?.data?.currentUserTradeEscrowBracket?.tradeEscrowBracket
          ?.weeklyLimit;

      if (weeklyLimit !== undefined) {
        this.trackingManager.setUserDataSnapshot({
          weeklyLimit,
        });
      }
    } catch (err: any) {
      console.error(
        '[PuppeteerTrackingBridge] Error intercepting EscrowBracket:',
        err.message,
      );
    }
  }

  /**
   * Intercept ExchangeRates response
   */
  private async interceptExchangeRates(response: any): Promise<void> {
    try {
      const text = await response.text();
      if (!text) return;

      const data = JSON.parse(text);
      const rates = data?.data?.exchangeRates?.rates;

      if (rates && Array.isArray(rates)) {
        const eurRate = rates.find((r: any) => r.currency === 'EUR')?.rate || 0;
        const usdRate = rates.find((r: any) => r.currency === 'USD')?.rate || 0;

        this.trackingManager.setUserDataSnapshot({
          exchangeRates: { EUR: eurRate, USD: usdRate },
        });
      }
    } catch (err: any) {
      console.error(
        '[PuppeteerTrackingBridge] Error intercepting ExchangeRates:',
        err.message,
      );
    }
  }

  /**
   * Check if all initial data has been collected
   */
  private allInitialDataCollected(): boolean {
    return (
      this.initialDataCollected.currentUser &&
      this.initialDataCollected.instantPayout &&
      this.initialDataCollected.escrowBracket &&
      this.initialDataCollected.exchangeRates &&
      this.initialDataCollected.tradeHistory
    );
  }

  /**
   * Start periodic trade history fetch every 15 minutes
   */
  private startPeriodicTradeHistoryFetch(): void {
    // Fetch every 15 minutes
    const intervalMs = 15 * 60 * 1000;

    this.periodicFetchInterval = setInterval(async () => {
      await this.fetchTradeHistoryIncremental();
    }, intervalMs);
  }

  /**
   * Fetch trade history incrementally (only new trades)
   */
  private async fetchTradeHistoryIncremental(): Promise<void> {
    if (!this.page || this.fetchingTradeHistory) return;

    const maxRetries = 3; // Fewer retries for periodic fetch
    const maxTotalTime = 30000; // 30 seconds for periodic fetch
    const startTime = Date.now();

    try {
      const snapshot = this.trackingManager.getUserDataSnapshot();
      if (!snapshot || !snapshot.userId) {
        console.warn(
          '[PuppeteerTrackingBridge] Cannot fetch trade history: No userId available',
        );
        return;
      }

      const userId = snapshot.userId;
      const tradesUrl = `https://www.api.example-service.local/player/${userId}/trades`;

      // Set flag to prevent main listener from handling TradeTable
      this.fetchingTradeHistory = true;

      let trades: any[] = [];
      let attempt = 0;

      while (attempt < maxRetries && trades.length === 0) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= maxTotalTime) {
          console.warn(
            `[PuppeteerTrackingBridge] Periodic fetch exceeded max time (${maxTotalTime}ms)`,
          );
          break;
        }

        attempt++;

        try {
          let responseHandlerActive = true;
          const tradeHistoryPromise = new Promise<any[]>((resolve) => {
            const responseHandler = async (response: any) => {
              try {
                if (!responseHandlerActive) return;

                const url = response.url();
                if (!url || !url.includes('router.api.example-service.local/graphql'))
                  return;
                if (response.request().method() === 'OPTIONS') return;
                if (response.status() !== 200) return;

                let operationName = '';
                try {
                  const urlObj = new URL(url);
                  operationName =
                    urlObj.searchParams.get('operationName') || '';
                } catch {}

                if (operationName === 'TradeTable') {
                  responseHandlerActive = false;
                  this.page?.off('response', responseHandler);

                  const text = await response.text();
                  if (!text) return resolve([]);

                  const data = JSON.parse(text);
                  const rawTrades =
                    data?.data?.trades?.data ||
                    data?.data?.trades?.edges?.map((e: any) => e.node) ||
                    (Array.isArray(data?.data?.trades) ? data.data.trades : []);

                  // Enhance trades with isBuy field and normalize items structure
                  const enhancedTrades = (rawTrades || []).map((trade: any) => {
                    const userId =
                      this.trackingManager.getUserDataSnapshot()?.userId;
                    const isBuy = trade.withdrawer?.id === userId;

                    return {
                      ...trade,
                      isBuy,
                      items: trade.tradeItems || trade.items || [],
                    };
                  });

                  resolve(enhancedTrades);
                }
              } catch (err: any) {
                resolve([]);
              }
            };

            this.page?.on('response', responseHandler);
          });

          await this.page.goto(tradesUrl, {
            waitUntil: 'networkidle2',
            timeout: 20000,
          });

          const remainingTime = maxTotalTime - (Date.now() - startTime);
          const waitTime = Math.min(8000, remainingTime);

          trades = await Promise.race([
            tradeHistoryPromise,
            new Promise<any[]>((resolve) =>
              setTimeout(() => resolve([]), waitTime),
            ),
          ]);

          if (trades.length > 0) break;

          if (attempt < maxRetries && trades.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (err: any) {
          console.error(
            `[PuppeteerTrackingBridge] Periodic fetch attempt ${attempt} failed:`,
            err.message,
          );
        }
      }

      // Filter to only new trades
      const newTrades = trades.filter(
        (trade) => !this.lastSeenTradeIds.has(trade.id),
      );

      if (newTrades.length > 0) {
        // Update last seen trade IDs
        newTrades.forEach((trade) => this.lastSeenTradeIds.add(trade.id));

        // Send only new trades
        await this.trackingManager.sendTradeHistory(newTrades);
      }
    } catch (err: any) {
      console.error(
        '[PuppeteerTrackingBridge] Periodic trade history fetch failed:',
        err.message,
      );
    } finally {
      this.fetchingTradeHistory = false;
    }
  }

  /**
   * Fetch trade history by navigating to player trades page (initial fetch)
   */
  public async fetchTradeHistory(): Promise<void> {
    if (!this.page || this.initialDataCollected.tradeHistory) return;

    const maxRetries = 5;
    const maxTotalTime = 60000; // 1 minute total
    const startTime = Date.now();

    try {
      const snapshot = this.trackingManager.getUserDataSnapshot();
      if (!snapshot || !snapshot.userId) {
        console.warn(
          '[PuppeteerTrackingBridge] Cannot fetch trade history: No userId available',
        );
        return;
      }

      const userId = snapshot.userId;
      const tradesUrl = `https://www.api.example-service.local/player/${userId}/trades`;

      // Set flag to prevent main listener from handling TradeTable
      this.fetchingTradeHistory = true;

      let trades: any[] = [];
      let attempt = 0;

      while (attempt < maxRetries && trades.length === 0) {
        // Check if we've exceeded the total time budget
        const elapsed = Date.now() - startTime;
        if (elapsed >= maxTotalTime) {
          console.warn(
            `[PuppeteerTrackingBridge] Trade history fetch exceeded max time (${maxTotalTime}ms)`,
          );
          break;
        }

        attempt++;

        try {
          // Set up one-time listener for TradeTable response using Puppeteer
          let responseHandlerActive = true;
          const tradeHistoryPromise = new Promise<any[]>((resolve) => {
            const responseHandler = async (response: any) => {
              try {
                if (!responseHandlerActive) return;

                const url = response.url();
                if (!url || !url.includes('router.api.example-service.local/graphql'))
                  return;

                // Skip preflight requests
                if (response.request().method() === 'OPTIONS') return;

                // Only process successful responses
                if (response.status() !== 200) return;

                // Extract operation name
                let operationName = '';
                try {
                  const urlObj = new URL(url);
                  operationName =
                    urlObj.searchParams.get('operationName') || '';
                } catch {}

                if (operationName === 'TradeTable') {
                  // Remove listener after first match
                  responseHandlerActive = false;
                  this.page?.off('response', responseHandler);

                  const text = await response.text();
                  if (!text) return resolve([]);

                  const data = JSON.parse(text);

                  // Try different possible paths for trade data
                  const rawTrades =
                    data?.data?.trades?.data ||
                    data?.data?.trades?.edges?.map((e: any) => e.node) ||
                    (Array.isArray(data?.data?.trades) ? data.data.trades : []);

                  // Enhance trades with isBuy field and normalize items structure
                  const enhancedTrades = (rawTrades || []).map((trade: any) => {
                    const userId =
                      this.trackingManager.getUserDataSnapshot()?.userId;
                    const isBuy = trade.withdrawer?.id === userId;

                    return {
                      ...trade,
                      isBuy,
                      items: trade.tradeItems || trade.items || [],
                    };
                  });

                  resolve(enhancedTrades);
                }
              } catch (err: any) {
                console.error(
                  '[PuppeteerTrackingBridge] Error intercepting TradeTable:',
                  err.message,
                );
                resolve([]);
              }
            };

            this.page?.on('response', responseHandler);
          });

          // Navigate to trades page
          await this.page.goto(tradesUrl, {
            waitUntil: 'networkidle2',
            timeout: 30000,
          });

          // Wait for trade history data (with timeout)
          const remainingTime = maxTotalTime - (Date.now() - startTime);
          const waitTime = Math.min(10000, remainingTime);

          trades = await Promise.race([
            tradeHistoryPromise,
            new Promise<any[]>((resolve) =>
              setTimeout(() => resolve([]), waitTime),
            ),
          ]);

          if (trades.length > 0) break;

          if (attempt < maxRetries && trades.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } catch (err: any) {
          console.error(
            `[PuppeteerTrackingBridge] Attempt ${attempt} failed:`,
            err.message,
          );
          // Continue to next retry
        }
      }

      // Send to backend (even if empty - backend needs to know)
      if (trades.length > 0) {
        // Track all trade IDs for future incremental fetches
        trades.forEach((trade) => this.lastSeenTradeIds.add(trade.id));

        await this.trackingManager.sendTradeHistory(trades);
      } else {
        console.warn(
          `[PuppeteerTrackingBridge] No trade history data received after ${attempt} attempts (user may have no trades yet)`,
        );
      }

      this.initialDataCollected.tradeHistory = true;

      // Check if all initial data collected and not yet sent
      if (this.allInitialDataCollected() && !this.userDataSnapshotSent) {
        await this.trackingManager.sendUserDataSnapshot();
        this.userDataSnapshotSent = true;
      }
    } catch (err: any) {
      console.error(
        '[PuppeteerTrackingBridge] Failed to fetch trade history:',
        err.message,
      );
      this.initialDataCollected.tradeHistory = true; // Mark as done to not block startup
    } finally {
      // Always unset the flag
      this.fetchingTradeHistory = false;
    }
  }
}

