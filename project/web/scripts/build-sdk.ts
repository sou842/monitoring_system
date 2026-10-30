// Builds the local JS SDK (`file:../../error-tracking-sdk/js`) before `next build`
// when its dist/ is missing. dist/ is git-ignored, so a fresh clone (e.g. on
// Vercel) has none and the SDK import can't be resolved without this step.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkDir = fileURLToPath(new URL('../../../error-tracking-sdk/js/', import.meta.url));

if (existsSync(join(sdkDir, 'dist', 'index.mjs'))) {
  console.log('[build-sdk] SDK dist/ found, skipping');
} else {
  console.log(`[build-sdk] building the SDK in ${sdkDir}`);
  execSync('npm ci --include=dev', { cwd: sdkDir, stdio: 'inherit' });
  execSync('npm run build', { cwd: sdkDir, stdio: 'inherit' });
}
