/**
 * TrackingManager - Coordinates all data tracking and backend synchronization
 *
 * Responsibilities:
 * 1. Track pending operations (sent to processor but not yet completed/cancelled)
 * 2. Monitor WebSocket messages for operation updates
 * 3. Intercept initial GraphQL requests for user data
 * 4. Send data to backend API
 */

import { EventEmitter } from 'events';

export interface PendingTrade {
  tradeId: string;
  sentAt: number; // timestamp when sent to processor
  expiresAt: number; // timestamp when we stop tracking (30min TTL)
  initialDataSent: boolean; // track if we already sent initial data
  msUntilJoinable: number | null; // ms until joinable at WS receive time
}

export interface TradeUpdateData {
  tradeId: string;
  status: 'JOINED' | 'PROCESSING' | 'COMPLETED_PROTECTED' | 'CANCELLED';
  joinedAt?: string;
  updatedAt: string;
  cancelReason?: string | null;
  totalValue: number;
  markupPercent: number;
  items: Array<{
    marketName: string;
    value: number;
  }>;
}

export interface UserDataSnapshot {
  userId: string;
  displayName: string;
  email: string | null;
  steamId: string;
  level: number;
  xp: number;
  coins: number; // Main wallet amount
  suspectedTrader: boolean;
  tradeBannedUntil: string | null;
  bannedUntil: string | null;
  weeklyLimit: number;
  remainingInstantPayoutAmount: number;
  exchangeRates: {
    EUR: number;
    USD: number;
  };
  collectedAt: number; // timestamp
}

export interface CoinUpdate {
  coins: number;
  reason: string;
  timestamp: number;
}

export class TrackingManager extends EventEmitter {
  private pendingTrades = new Map<string, PendingTrade>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private userDataSnapshot: UserDataSnapshot | null = null;
  private backendUrl: string;
  private sessionId: string;
  private pendingCoinUpdates: CoinUpdate[] = []; // Queue for coin updates before userId available

  constructor(backendUrl: string, sessionId: string) {
    super();
    this.backendUrl = backendUrl;
    this.sessionId = sessionId;
  }

  /**
   * Start tracking manager
   */
  public start(): void {
    // Cleanup expired trades every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredTrades();
    }, 5 * 60 * 1000);
  }

  /**
   * Stop tracking manager
   */
  public stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Add trade IDs that were sent to processor
   */
  public addPendingTrades(
    tradeIds: string[],
    msUntilJoinableValues?: Map<string, number | null>
  ): void {
    const now = Date.now();
    const expiresAt = now + 30 * 60 * 1000; // 30 minutes TTL

    for (const tradeId of tradeIds) {
      this.pendingTrades.set(tradeId, {
        tradeId,
        sentAt: now,
        expiresAt,
        initialDataSent: false,
        msUntilJoinable: msUntilJoinableValues?.get(tradeId) ?? null,
      });
    }
  }

  /**
   * Handle trade update from WebSocket
   */
  public async handleTradeUpdate(updateData: any): Promise<void> {
    try {
      const trade = updateData?.data?.updateTrade?.trade;
      if (!trade || !trade.id) return;

      const tradeId = trade.id;
      const pending = this.pendingTrades.get(tradeId);

      // Only process if we're tracking this trade
      if (!pending) return;

      const status = trade.status as string;

      // Step 1: Send initial trade data (when status = JOINED)
      if (status === 'JOINED' && !pending.initialDataSent) {
        await this.sendInitialTradeData(trade);
        pending.initialDataSent = true;
      }

      // Step 2: Send final trade data (when status = COMPLETED_PROTECTED or CANCELLED)
      if (status === 'COMPLETED_PROTECTED' || status === 'CANCELLED') {
        await this.sendFinalTradeData(trade);
        // Remove from pending (trade is complete)
        this.pendingTrades.delete(tradeId);
      }
    } catch (err: any) {
      console.error('[TrackingManager] Error handling trade update:', err.message);
    }
  }

  /**
   * Handle coin update
   */
  public async handleCoinUpdate(coins: number, reason: string): Promise<void> {
    try {
      const update: CoinUpdate = {
        coins,
        reason,
        timestamp: Date.now(),
      };

      // If userId not available yet, queue the update
      if (!this.userDataSnapshot || !this.userDataSnapshot.userId) {
        this.pendingCoinUpdates.push(update);
        return;
      }

      await this.sendToBackend('/api/tracking/coins', {
        sessionId: this.sessionId,
        TaskDispatcherUserId: this.userDataSnapshot.userId,
        ...update,
      });
    } catch (err: any) {
      console.error('[TrackingManager] Error sending coin update:', err.message);
    }
  }

  /**
   * Store user data snapshot from initial requests
   */
  public setUserDataSnapshot(data: Partial<UserDataSnapshot>): void {
    if (!this.userDataSnapshot) {
      this.userDataSnapshot = {
        userId: '',
        displayName: '',
        email: null,
        steamId: '',
        level: 0,
        xp: 0,
        coins: 0,
        suspectedTrader: false,
        tradeBannedUntil: null,
        bannedUntil: null,
        weeklyLimit: 0,
        remainingInstantPayoutAmount: 0,
        exchangeRates: { EUR: 0, USD: 0 },
        collectedAt: Date.now(),
      };
    }

    const hadUserId = !!this.userDataSnapshot.userId;

    // Merge new data, but don't overwrite valid values with 0/empty if we already have them
    const dataToMerge = { ...data };

    // Don't regress coins
    if (dataToMerge.coins === 0 && this.userDataSnapshot.coins > 0) {
      delete dataToMerge.coins;
    }

    // Don't regress level
    if (dataToMerge.level === 0 && this.userDataSnapshot.level > 0) {
      delete dataToMerge.level;
    }

    // Don't regress xp
    if (dataToMerge.xp === 0 && this.userDataSnapshot.xp > 0) {
      delete dataToMerge.xp;
    }

    // Don't regress weeklyLimit
    if (dataToMerge.weeklyLimit === 0 && this.userDataSnapshot.weeklyLimit > 0) {
      delete dataToMerge.weeklyLimit;
    }

    // Don't regress exchange rates
    if (dataToMerge.exchangeRates) {
      if (dataToMerge.exchangeRates.EUR === 0 && this.userDataSnapshot.exchangeRates.EUR > 0) {
        dataToMerge.exchangeRates.EUR = this.userDataSnapshot.exchangeRates.EUR;
      }
      if (dataToMerge.exchangeRates.USD === 0 && this.userDataSnapshot.exchangeRates.USD > 0) {
        dataToMerge.exchangeRates.USD = this.userDataSnapshot.exchangeRates.USD;
      }
    }

    Object.assign(this.userDataSnapshot, dataToMerge);

    // If userId just became available, flush pending coin updates
    if (!hadUserId && this.userDataSnapshot.userId) {
      this.flushPendingCoinUpdates();
    }
  }

  /**
   * Flush pending coin updates when userId becomes available
   */
  private async flushPendingCoinUpdates(): Promise<void> {
    if (this.pendingCoinUpdates.length === 0) return;

    const updates = [...this.pendingCoinUpdates];
    this.pendingCoinUpdates = [];

    for (const update of updates) {
      try {
        if (!this.userDataSnapshot || !this.userDataSnapshot.userId) break;

        await this.sendToBackend('/api/tracking/coins', {
          sessionId: this.sessionId,
          TaskDispatcherUserId: this.userDataSnapshot.userId,
          ...update,
        });
      } catch (err: any) {
        console.error('[TrackingManager] Error flushing coin update:', err.message);
      }
    }
  }

  /**
   * Send complete user data snapshot to backend (called once after all initial data collected)
   */
  public async sendUserDataSnapshot(): Promise<void> {
    if (!this.userDataSnapshot) {
      console.warn('[TrackingManager] No user data snapshot to send');
      return;
    }

    // Ensure userId is available
    if (!this.userDataSnapshot.userId) {
      console.warn('[TrackingManager] Cannot send user data snapshot: userId not yet available');
      return;
    }

    try {
      await this.sendToBackend('/api/tracking/user-data', {
        sessionId: this.sessionId,
        ...this.userDataSnapshot,
      });
    } catch (err: any) {
      console.error('[TrackingManager] Error sending user data snapshot:', err.message);
    }
  }

  /**
   * Get user data snapshot (for fallback coin values)
   */
  public getUserDataSnapshot(): UserDataSnapshot | null {
    return this.userDataSnapshot;
  }

  /**
   * Send trade history to backend in batches to avoid exceeding body size limit
   */
  public async sendTradeHistory(tradeHistory: any[]): Promise<void> {
    try {
      // Ensure userId is available
      if (!this.userDataSnapshot || !this.userDataSnapshot.userId) {
        console.warn('[TrackingManager] Cannot send trade history: userId not yet available');
        return;
      }

      // Sanitize trade history data to match backend validation and ensure imageUrl is included
      const sanitizedTrades = tradeHistory.map((trade: any) => {
        const sanitized = {
          ...trade,
          markupPercent: typeof trade.markupPercent === 'number' ? trade.markupPercent : 0,
          joinedAt: trade.joinedAt || trade.createdAt || new Date().toISOString(),
          // Ensure items have imageUrl extracted properly
          items: trade.items?.map((item: any) => ({
            ...item,
            imageUrl: item.imageUrl || item.itemVariant?.iconUrl || item.itemVariant?.image || item.image || null,
            stickers: item.stickers?.map((sticker: any) => ({
              name: sticker.name || '',
              imageUrl: sticker.imageUrl || sticker.iconUrl || sticker.image || '',
              value: sticker.value || 0,
            })) || [],
          })) || [],
        };

        return sanitized;
      });


      // Send in batches to avoid exceeding 100KB limit
      const batchSize = 10;

      for (let i = 0; i < sanitizedTrades.length; i += batchSize) {
        const batch = sanitizedTrades.slice(i, i + batchSize);

        const requestBody = {
          sessionId: this.sessionId,
          TaskDispatcherUserId: this.userDataSnapshot.userId,
          trades: batch,
          timestamp: Date.now(),
        };

        try {
          await this.sendToBackend('/api/tracking/trade-history', requestBody);
        } catch (err: any) {
          console.error(`[TrackingManager] Batch failed:`, err.message);
        }

        if (i + batchSize < sanitizedTrades.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } catch (err: any) {
      console.error('[TrackingManager] Error sending trade history:', err.message);
    }
  }

  /**
   * Send initial trade data to backend (status = JOINED)
   */
  private async sendInitialTradeData(trade: any): Promise<void> {
    try {
      // Ensure userId is available
      if (!this.userDataSnapshot || !this.userDataSnapshot.userId) {
        console.warn('[TrackingManager] Cannot send trade initial: userId not yet available');
        return;
      }

      // Get the pending trade to access msUntilJoinable value
      const pending = this.pendingTrades.get(trade.id);

      // Use the msUntilJoinable value that was calculated when the WS message came in
      // This is the most accurate value (calculated at exact WS receive time)
      const msUntilJoinable = pending?.msUntilJoinable ?? null;

      const data = {
        sessionId: this.sessionId,
        TaskDispatcherUserId: this.userDataSnapshot.userId,
        tradeId: trade.id,
        status: 'JOINED',
        joinedAt: trade.joinedAt,
        totalValue: trade.totalValue,
        markupPercent: trade.markupPercent,
        msUntilJoinable,
        items: trade.tradeItems?.map((item: any) => ({
          marketName: item.marketName,
          value: item.value,
          // WebSocket uses iconUrl in itemVariant
          imageUrl: item.itemVariant?.iconUrl || item.itemVariant?.image || null,
          // Stickers is directly on item (not in itemVariant) for WebSocket
          stickers: (item.stickers || item.itemVariant?.stickers || []).map((sticker: any) => ({
            name: sticker.name || '',
            // Stickers use imageUrl field in WebSocket
            imageUrl: sticker.imageUrl || sticker.image || '',
            value: sticker.value || 0,
            wear: sticker.wear || 0,
          })),
        })) || [],
        timestamp: Date.now(),
      };

      await this.sendToBackend('/api/tracking/trade-initial', data);
    } catch (err: any) {
      console.error('[TrackingManager] Error sending initial trade data:', err.message);
    }
  }

  /**
   * Send final trade data to backend (status = COMPLETED_PROTECTED or CANCELLED)
   */
  private async sendFinalTradeData(trade: any): Promise<void> {
    try {
      // Ensure userId is available
      if (!this.userDataSnapshot || !this.userDataSnapshot.userId) {
        console.warn('[TrackingManager] Cannot send trade final: userId not yet available');
        return;
      }

      const data = {
        sessionId: this.sessionId,
        TaskDispatcherUserId: this.userDataSnapshot.userId,
        tradeId: trade.id,
        status: trade.status,
        updatedAt: trade.updatedAt,
        cancelReason: trade.cancelReason,
        totalValue: trade.totalValue,
        markupPercent: trade.markupPercent,
        items: trade.tradeItems?.map((item: any) => ({
          marketName: item.marketName,
          value: item.value,
          // WebSocket uses iconUrl in itemVariant
          imageUrl: item.itemVariant?.iconUrl || item.itemVariant?.image || null,
          // Stickers is directly on item (not in itemVariant) for WebSocket
          stickers: (item.stickers || item.itemVariant?.stickers || []).map((sticker: any) => ({
            name: sticker.name || '',
            // Stickers use imageUrl field in WebSocket
            imageUrl: sticker.imageUrl || sticker.image || '',
            value: sticker.value || 0,
            wear: sticker.wear || 0,
          })),
        })) || [],
        timestamp: Date.now(),
      };

      await this.sendToBackend('/api/tracking/trade-final', data);
    } catch (err: any) {
      console.error('[TrackingManager] Error sending final trade data:', err.message);
    }
  }

  /**
   * Send data to backend API
   */
  private async sendToBackend(endpoint: string, data: any): Promise<void> {
    const url = `${this.backendUrl}${endpoint}`;

    try {
      const requestBody = JSON.stringify(data);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ayuV2WlHWwqk80kI83ZMHETgCQyVPQxSlxdhCm93oPS87JK69o9QKS2cCpT72pcb',
        },
        body: requestBody,
        redirect: 'manual',
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => 'Unable to read response');
        throw new Error(`Backend returned ${response.status}: ${response.statusText} - ${responseText}`);
      }
    } catch (err: any) {
      // Don't throw - tracking failures should not crash the bot
      console.error(`[TrackingManager] ❌ Failed to send to ${endpoint}:`, err.message);
    }
  }

  /**
   * Cleanup expired pending trades
   */
  private cleanupExpiredTrades(): void {
    const now = Date.now();

    for (const [tradeId, pending] of this.pendingTrades) {
      if (pending.expiresAt <= now) {
        this.pendingTrades.delete(tradeId);
      }
    }
  }
}

