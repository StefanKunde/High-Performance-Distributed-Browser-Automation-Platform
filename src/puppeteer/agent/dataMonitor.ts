import { Page } from 'rebrowser-puppeteer';
import { GRAPHQL_URL } from './constants';

export type DataUpdateListener = (data: any) => void;

/**
 * Monitor GraphQL responses and WebSocket frames for data updates
 */
export async function attachDataMonitor(p: Page, onUpdate: DataUpdateListener) {
  const client = await (p as any)._client();

  // Monitor HTTP responses
  client.on('Network.responseReceived', async (evt: any) => {
    try {
      if (!evt.response?.url?.startsWith(GRAPHQL_URL)) return;
      const { requestId } = evt;
      const body = await client
        .send('Network.getResponseBody', { requestId })
        .catch(() => null);
      if (!body || !body.body) return;

      try {
        const data = JSON.parse(body.body);
        onUpdate(data);
      } catch {}
    } catch {}
  });

  // Monitor WebSocket frames
  client.on('Network.webSocketFrameReceived', (evt: any) => {
    try {
      const payload = evt.response?.payloadData;
      if (!payload || typeof payload !== 'string') return;

      const ch0 = payload.charCodeAt(0);
      if (ch0 !== 123 && ch0 !== 91) return;

      try {
        const data = JSON.parse(payload);
        onUpdate(data);
      } catch {}
    } catch {}
  });

  await client
    .send('Network.enable', { maxTotalBufferSize: 1024 * 1024 })
    .catch(() => {});
}
