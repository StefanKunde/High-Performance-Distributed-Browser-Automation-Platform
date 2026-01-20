# Browser Automation Platform

Distributed browser automation system with WebSocket connection pooling. Portfolio project exploring distributed systems patterns and browser lifecycle management.

⚠️ **Note:** This is a sanitized demonstration. Original implementation details have been simplified for portfolio purposes.

## What it does

Manages multiple browser instances with efficient inter-process communication:
- WebSocket connection pooling (8+ concurrent connections)
- Event deduplication across connections
- Browser lifecycle management with Puppeteer
- Chrome DevTools Protocol (CDP) integration

## Tech Stack

- **Node.js 18+** - Runtime
- **TypeScript 5.8** - Strict mode
- **Puppeteer Extra** - Browser automation with stealth plugins
- **ws** - WebSocket client library
- **RxJS** - Event stream processing

## Key Components

### 1. WebSocketCluster (Connection Pooling)

```typescript
class WebSocketCluster {
  private connections: Map<string, WebSocket> = new Map();
  private eventCache = new Map<string, number>(); // Deduplication

  // Health monitoring with exponential backoff reconnection
  private async reconnect(id: string): Promise<void> {
    let delay = 1000;
    while (!this.isConnected(id)) {
      await this.sleep(delay);
      await this.connect(id);
      delay = Math.min(delay * 2, 30000); // Max 30s
    }
  }

  // Event deduplication (60-second TTL window)
  private isDuplicate(eventId: string): boolean {
    const timestamp = this.eventCache.get(eventId);
    if (timestamp && Date.now() - timestamp < 60000) {
      return true;
    }
    this.eventCache.set(eventId, Date.now());
    return false;
  }
}
```

### 2. BrowserAgent (Puppeteer Integration)

```typescript
class BrowserAgent {
  private browser: Browser;

  async launch(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
  }

  // CDP session for network interception
  async interceptNetwork(page: Page): Promise<void> {
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    client.on('Network.requestWillBeSent', this.handleRequest);
  }
}

## Performance Metrics

- **WebSocket Throughput:** 1000+ events/sec per connection
- **Browser Startup:** 3-5 seconds (with profile reuse)
- **Memory:** 200MB base + 100MB per browser instance
- **Event Processing:** <1ms deduplication overhead

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- TypeScript 5.8+
- Linux/macOS (for Unix Domain Sockets)

### Installation

```bash
npm install
```

### Configuration

Create a `.env` file (see [.env.example](.env.example)):

```env
SESSION_ID=your-session-id
WS_URL=wss://example.com/stream
PROCESSING_SERVICE_SOCKET=/tmp/processor.sock
```

### Running

```bash
# Development mode with hot reload
npm run dev

# Production build
npm run build
npm start

# Type checking
npm run typecheck

# Linting
npm run lint
```

## 🔧 Core Technologies

| Technology              | Purpose                                 |
| ----------------------- | --------------------------------------- |
| **TypeScript 5.8**      | Type-safe codebase with strict mode     |
| **Puppeteer Extra**     | Browser automation with stealth plugins |
| **rebrowser-puppeteer** | Enhanced browser fingerprint resistance |
| **ws (WebSocket)**      | Low-level WebSocket client library      |
| **Node.js net**         | Unix Domain Socket IPC                  |
| **RxJS**                | Reactive event stream processing        |

## 📁 Project Structure

```
src/
├── app/
│   └── boot.ts                    # Application bootstrap & lifecycle
├── executor/
│   └── TaskExecutorClient.ts      # Binary protocol IPC client
├── net/
│   └── WebSocketCluster.ts        # WebSocket connection pooling
├── puppeteer/
│   ├── BrowserAgent.ts            # Browser lifecycle manager
│   └── agent/
│       ├── constants.ts           # Configuration constants
│       ├── cookies.ts             # Session cookie utilities
│       ├── dataMonitor.ts         # GraphQL/WS traffic monitor
│       ├── pageInteraction.ts    # Page automation helpers
│       ├── profile.ts             # Chrome profile management
│       ├── tokenGenerator.ts      # Auth token extraction
│       ├── ui.ts                  # UI interaction utilities
│       └── warm.ts                # Browser warmup routines
├── tracking/
│   ├── PuppeteerTrackingBridge.ts # Browser-to-tracking integration
│   └── TrackingManager.ts         # Telemetry & monitoring
└── main.ts                        # Entry point
```

## What I Learned

**Distributed Systems Patterns**
- Event deduplication with TTL windows
- Connection pooling and health checks
- Exponential backoff for retries
- Graceful degradation

**Browser Automation**
- Chrome DevTools Protocol (CDP)
- Puppeteer lifecycle management
- Memory management for multiple instances
- Network interception techniques

**Performance Optimization**
- WebSocket connection reuse
- RxJS operator efficiency

## Not Production-Ready

This is a learning/portfolio project. For production:
- Use established protocols (gRPC, MessagePack)
- Add comprehensive error handling
- Implement proper logging
- Security hardening (auth, encryption)
- Testing across failure scenarios
- Documentation and API contracts

## Why "Sanitized"?

The original project was built for a specific use case with proprietary logic. This version:
- Removes business-specific details
- Simplifies to core technical patterns
- Demonstrates skills without revealing proprietary information
- Focuses on architectural decisions

## License

MIT

## Author

Stefan Kunde
