// hot-bridge.ts (Node)
import fs from 'node:fs';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';

const pems = selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
  days: 365,
  keySize: 2048,
});

const server = https.createServer({ key: pems.private, cert: pems.cert });
const ws = new WebSocketServer({
  server,
  perMessageDeflate: false,
  clientTracking: true,
});
server.listen(18443, '127.0.0.1', () =>
  console.log('[hotws] ws://127.0.0.1:18443'),
);

let last: any = null;
ws.on('connection', (ws, req) => {
  // Optional origin check:
  console.log('CONNECTED HOT WS');
  const origin = req.headers.origin;
  if (
    process.env.HOTWS_CHECK_ORIGIN === '1' &&
    origin !== 'https://router.api.example-service.local'
  ) {
    ws.close();
    return;
  }
  last = ws;
  ws.on('close', () => {
    if (last === ws) last = null;
  });
});

// Push either a compact frame or a full JSON body string:
export function hotJoinSendCompact(
  tradeId: string,
  v3: string,
  v2?: string,
): boolean {
  if (!last || last.readyState !== last.OPEN) return false;
  last.send(v2 ? `${tradeId}|${v3}|${v2}` : `${tradeId}|${v3}`);
  return true;
}
export function hotJoinSendRaw(bodyJson: string): boolean {
  if (!last || last.readyState !== last.OPEN) return false;
  last.send(bodyJson);
  return true;
}

