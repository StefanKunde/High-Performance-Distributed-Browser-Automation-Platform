import { initialize } from './app/boot';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  try {
    await initialize();
  } catch (e: any) {
    console.error('[main] Fatal startup error:', e?.message || e);
    process.exit(1);
  }
}

process.on('unhandledRejection', (err: any) => {
  console.error('[unhandledRejection]', err?.message || err);
  console.error('[unhandledRejection] Stack:', err?.stack || 'No stack trace');
  process.exit(1);
});

process.on('uncaughtException', (err: any) => {
  console.error('[uncaughtException]', err?.message || err);
  process.exit(1);
});

main();
