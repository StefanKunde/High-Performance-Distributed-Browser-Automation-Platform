import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';

export async function ensureProfileUnlocked(dir: string): Promise<void> {
  // Create directory if it doesn't exist
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err: any) {
    // Ignore error if directory already exists
    if (err.code !== 'EEXIST') {
      console.warn('[profile] Failed to create directory:', dir, err.message);
    }
  }

  const devtoolsPortFile = path.join(dir, 'DevToolsActivePort');
  const lockFiles = [
    path.join(dir, 'SingletonLock'),
    path.join(dir, 'SingletonCookie'),
    path.join(dir, 'SingletonSocket'),
  ];

  try {
    if (fssync.existsSync(devtoolsPortFile)) {
      return;
    }
  } catch {}

  for (const pth of lockFiles) {
    try {
      if (fssync.existsSync(pth)) {
        await fs.rm(pth, { force: true });
      }
    } catch {}
  }
}
