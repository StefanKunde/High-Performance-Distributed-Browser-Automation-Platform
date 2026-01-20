// Application bootstrap for distributed data processing platform

import { BrowserAgent } from '../puppeteer/BrowserAgent';
import { DataEvent, WebSocketCluster } from '../net/WebSocketCluster';
import { TaskExecutorClient } from '../executor/TaskExecutorClient';
import { TrackingManager } from '../tracking/TrackingManager';
import { PuppeteerTrackingBridge } from '../tracking/PuppeteerTrackingBridge';

let cluster: WebSocketCluster;
let agent: BrowserAgent;
let taskExecutor: TaskExecutorClient;
let trackingManager: TrackingManager;

const SESSION_ID = process.env.SESSION_ID || 'default-session';
const WS_URL = process.env.WS_URL || 'wss://api.example-service.local/stream';

/**
 * Initialize the distributed data processing system
 */
export async function initialize(): Promise<void> {
  console.log('[boot] Initializing data processing platform...');

  const sessionId = SESSION_ID;
  const filterItems: string[] = [];

  console.log({ sessionId, filterItems });

  const trackingUrl =
    process.env.TRACKING_BACKEND_URL || 'https://monitoring.example-service.local';

  trackingManager = new TrackingManager(trackingUrl, sessionId);
  trackingManager.start();

  const executorInitialized = false;
  try {
    taskExecutor = new TaskExecutorClient(
      process.env.PROCESSING_SERVICE_SOCKET || '/tmp/processor.sock',
    );
    await taskExecutor.connect();
    console.log('[boot] ✓ Processing service connected');
  } catch (err: any) {
    console.warn('[boot] ⚠ Processing service connection failed:', err.message);
    console.warn('[boot] ⚠ Data will be logged but not processed');
  }

  const userAgent =
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

  agent = new BrowserAgent({
    session: sessionId,
    headful: true,
    userAgent,
  });

  cluster = new WebSocketCluster(WS_URL, {
    cookieHeader: '',
    userAgent,
    connections: 8,
    buildSubscribePayload: () => ({
      id: '1',
      type: 'subscribe',
      payload: {
        variables: {},
        extensions: {},
        operationName: 'DataStream',
        query: 'subscription DataStream { dataEvents { id data } }',
      },
    }),
  });

  cluster.onData(async (ev: DataEvent): Promise<void> => {
    console.log('[DATA] Received event:', ev.eventId);

    // Process event
    if (taskExecutor && taskExecutor.isConnected()) {
      try {
        await taskExecutor.executeTask('USER', ev.eventId, BigInt(Date.now()));
      } catch (e: any) {
        console.error('[ERROR] Data processing failed:', e.message);
      }
    }
  });

  agent.on('cookies', (payload: any) => {
    if (payload.header) {
      cluster.updateCookieHeader(payload.header);
    }
  });

  agent.on('authCookies', async (payload: any) => {
    console.log('[boot] Auth cookies updated');
  });

  agent.on('metadata', async (meta: any) => {
    console.log('[boot] Metadata received:', meta);
  });

  console.log('[boot] Starting browser session...');
  await agent.start();

  const cookies = agent.getUserCookieHeader();
  if (cookies) {
    cluster.updateCookieHeader(cookies);
  }

  console.log('[boot] Starting WebSocket cluster...');
  await cluster.start();

  console.log('[boot] ✓ System initialized successfully');

  process.on('SIGINT', async () => {
    console.log('[boot] Shutting down...');
    cluster.stop();
    await agent.close();
    if (taskExecutor) {
      taskExecutor.disconnect();
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[boot] Shutting down...');
    cluster.stop();
    await agent.close();
    if (taskExecutor) {
      taskExecutor.disconnect();
    }
    process.exit(0);
  });
}

if (require.main === module) {
  initialize().catch((err) => {
    console.error('[boot] Fatal error:', err);
    process.exit(1);
  });
}
