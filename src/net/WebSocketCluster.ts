// WebSocket cluster for distributed data streaming
// Manages multiple concurrent connections for high-throughput data processing

import WebSocket, { RawData } from 'ws';
import crypto from 'crypto';
import zlib from 'zlib';
import https from 'https';

const B_PONG = Buffer.from('"pong"');
const B_ACK_1 = Buffer.from('"connection_ack"');
const B_ACK_2 = Buffer.from('"type":"connection_ack"');
const B_DATA_EVENT = Buffer.from('"dataEvent"');

export interface DataEvent {
  eventId: string;
  rttMs: number | null;
  socketId: string;
  payload: any;
}

export interface ClusterOptions {
  cookieHeader: string;
  userAgent: string;
  connections?: number;
  handshakeTimeoutMs?: number;
  buildSubscribePayload?: () => SubscribeFrame;
  log?: Pick<Console, 'log' | 'error'>;
  maxPayload?: number;
}

export interface SubscribeFrame {
  id: string;
  type: 'subscribe';
  payload: {
    variables: Record<string, unknown>;
    extensions: Record<string, unknown>;
    operationName: string;
    query: string;
  };
}

interface SocketStats {
  messagesReceived: number;
  createdAt: number;
  totalLifetime: number;
}

/**
 * High-performance WebSocket cluster for distributed data streaming
 */
export class WebSocketCluster {
  private wsUrl: string;
  private stopped = false;
  private dataHandler: ((evt: DataEvent) => void) | null = null;

  private opts: Required<Omit<ClusterOptions, 'buildSubscribePayload' | 'log'>> & {
    buildSubscribePayload?: () => SubscribeFrame;
    log: Pick<Console, 'log' | 'error'>;
  };

  private sockets = new Map<string, WebSocket>();
  private socketsAcked = new Set<string>();
  private socketStats = new Map<string, SocketStats>();

  private dedupSet = new Set<string>();
  private dedupCleanupTimer: NodeJS.Timeout | null = null;

  constructor(wsUrl: string, options: ClusterOptions) {
    this.wsUrl = wsUrl;
    this.opts = {
      connections: options.connections ?? 8,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 15_000,
      maxPayload: options.maxPayload ?? 262_144,
      log: options.log ?? console,
      cookieHeader: options.cookieHeader,
      userAgent: options.userAgent,
      buildSubscribePayload: options.buildSubscribePayload,
    };
  }

  public onData(handler: (evt: DataEvent) => void): void {
    this.dataHandler = handler;
  }

  public updateCookieHeader(cookieHeader: string): void {
    this.opts.cookieHeader = cookieHeader;
  }

  public async start(): Promise<void> {
    this.stopped = false;
    this.startDedupCleanup();

    for (let i = 0; i < this.opts.connections; i++) {
      const socketId = crypto.randomBytes(4).toString('hex');
      await this.createSocket(socketId);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }
    for (const [id, ws] of this.sockets) {
      try {
        ws.terminate();
      } catch {}
    }
    this.sockets.clear();
    this.socketsAcked.clear();
    this.socketStats.clear();
  }

  private async createSocket(socketId: string): Promise<void> {
    if (this.stopped) return;

    try {
      const agent = new https.Agent({
        keepAlive: true,
        ALPNProtocols: ['http/1.1'],
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
      });

      const ws = new WebSocket(this.wsUrl, {
        agent,
        headers: {
          'User-Agent': this.opts.userAgent,
          Cookie: this.opts.cookieHeader,
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://app.example-service.local',
        },
        handshakeTimeout: this.opts.handshakeTimeoutMs,
        maxPayload: this.opts.maxPayload,
      });

      this.sockets.set(socketId, ws);

      const stats: SocketStats = {
        messagesReceived: 0,
        createdAt: Date.now(),
        totalLifetime: 0,
      };
      this.socketStats.set(socketId, stats);

      ws.on('open', () => {
        this.opts.log.log(`[WS] Socket ${socketId} connected`);
      });

      ws.on('message', (data: RawData) => {
        this.handleMessage(socketId, data);
      });

      ws.on('close', (code, reason) => {
        this.opts.log.log(
          `[WS] Socket ${socketId} closed: ${code} ${reason.toString()}`,
        );
        this.sockets.delete(socketId);
        this.socketsAcked.delete(socketId);
        this.socketStats.delete(socketId);

        if (!this.stopped) {
          setTimeout(() => {
            const newId = crypto.randomBytes(4).toString('hex');
            this.createSocket(newId);
          }, 1000);
        }
      });

      ws.on('error', (err) => {
        this.opts.log.error(`[WS] Socket ${socketId} error:`, err.message);
      });
    } catch (err: any) {
      this.opts.log.error(`[WS] Failed to create socket ${socketId}:`, err.message);
    }
  }

  private handleMessage(socketId: string, data: RawData): void {
    try {
      let buf: Buffer;
      if (Buffer.isBuffer(data)) {
        buf = data;
      } else if (Array.isArray(data)) {
        buf = Buffer.concat(data);
      } else {
        buf = Buffer.from(data.toString());
      }

      if (buf.includes(B_PONG)) return;

      if (buf.includes(B_ACK_1) || buf.includes(B_ACK_2)) {
        this.socketsAcked.add(socketId);
        if (this.opts.buildSubscribePayload) {
          const ws = this.sockets.get(socketId);
          if (ws && ws.readyState === WebSocket.OPEN) {
            const sub = this.opts.buildSubscribePayload();
            ws.send(JSON.stringify(sub));
          }
        }
        return;
      }

      if (!this.socketsAcked.has(socketId)) return;

      const receiveTime = Date.now();
      let payload: any;

      try {
        const text = buf.toString('utf8');
        payload = JSON.parse(text);
      } catch {
        return;
      }

      const eventId = this.extractEventId(payload);
      if (!eventId) return;

      if (this.dedupSet.has(eventId)) return;
      this.dedupSet.add(eventId);

      const stats = this.socketStats.get(socketId);
      if (stats) {
        stats.messagesReceived++;
        stats.totalLifetime++;
      }

      if (this.dataHandler) {
        this.dataHandler({
          eventId,
          rttMs: null,
          socketId,
          payload,
        });
      }
    } catch (err) {
      this.opts.log.error('[WS] Message handling error:', err);
    }
  }

  private extractEventId(payload: unknown): string | null {
    if (typeof payload !== 'object' || !payload) return null;

    const p = payload as any;

    if (p.type === 'next' && p.payload?.data) {
      const dataEvents = p.payload.data.dataEvents?.events;
      if (Array.isArray(dataEvents) && dataEvents.length > 0 && dataEvents[0]?.id) {
        return String(dataEvents[0].id);
      }
    }

    if (Array.isArray(p.events) && p.events.length > 0 && p.events[0]?.id) {
      return String(p.events[0].id);
    }

    return null;
  }

  private startDedupCleanup(): void {
    this.dedupCleanupTimer = setInterval(() => {
      this.dedupSet.clear();
    }, 30_000);
  }

  public getStats(): {
    totalSockets: number;
    ackedSockets: number;
    totalMessages: number;
  } {
    let totalMessages = 0;
    for (const stats of this.socketStats.values()) {
      totalMessages += stats.messagesReceived;
    }

    return {
      totalSockets: this.sockets.size,
      ackedSockets: this.socketsAcked.size,
      totalMessages,
    };
  }
}
