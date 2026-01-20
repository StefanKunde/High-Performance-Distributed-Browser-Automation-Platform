export const API_ORIGIN =
  process.env.API_ORIGIN || 'https://api.example-service.local';
export const GRAPHQL_URL = process.env.GRAPHQL_URL || `${API_ORIGIN}/graphql`;
export const SITE_URL =
  process.env.SITE_URL || 'https://app.example-service.local/';

// Minimal resource args for Chrome, but window stays visible (headful)
export const CHROME_ARGS = [
  //'--no-sandbox', // keep if you run as root / in Docker
  '--window-position=96,104', // avoid 0,0 placement for input heuristics
  '--lang=en-US', // align navigator.language with Accept-Language
  //'--enable-quic', // fine (you already use it)

  // Nice-to-have quality-of-life
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',

  // Testing new
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-infobars',
  '--proxy-bypass-list=<-loopback>,127.0.0.1,localhost',
  '--host-resolver-rules="MAP localhost 127.0.0.1"',
  '--force-webrtc-ip-handling-policy',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
];
