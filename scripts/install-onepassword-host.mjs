#!/usr/bin/env node
// Registers the Chrome Native Messaging Host (`com.intelia.invoice_extractor.op`)
// for macOS/Linux Chrome, Chromium, Brave, Arc, and local `.chrome-dev-profile`.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_HOST_NAME } from '../onepassword.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const hostScriptPath = join(
  repoRoot,
  'scripts',
  platform() === 'win32' ? 'onepassword-host.cmd' : 'onepassword-host.sh'
);

// Chromium's crx_file::id_util::GenerateId for an unpacked extension path
export function computeUnpackedExtensionId(extPath) {
  const digest = createHash('sha256').update(extPath, 'utf8').digest('hex').slice(0, 32);
  let out = '';
  for (let i = 0; i < digest.length; i++) {
    out += String.fromCharCode(97 + parseInt(digest[i], 16));
  }
  return out;
}

function discoverExtensionIdsFromProfileDir(userDataDir) {
  const found = new Set();
  if (!existsSync(userDataDir)) return found;

  let subdirs = ['Default'];
  try {
    for (const entry of readdirSync(userDataDir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'Default' || entry.name.startsWith('Profile '))) {
        subdirs.push(entry.name);
      }
    }
  } catch {
    // Ignore unreadable dirs
  }

  for (const sub of new Set(subdirs)) {
    for (const prefFile of ['Preferences', 'Secure Preferences']) {
      const p = join(userDataDir, sub, prefFile);
      if (!existsSync(p)) continue;
      try {
        const data = JSON.parse(readFileSync(p, 'utf8'));
        const settings = data?.extensions?.settings || {};
        for (const [id, info] of Object.entries(settings)) {
          if (!/^[a-p]{32}$/.test(id)) continue;
          const extPath = String(info?.path || '');
          const extName = String(info?.manifest?.name || '');
          if (
            extPath === repoRoot ||
            extPath.endsWith('/invoice-extractor') ||
            extName === 'Invoice Extractor'
          ) {
            found.add(id);
          }
        }
      } catch {
        // Ignore malformed preference files
      }
    }
  }
  return found;
}

export function collectAllowedOrigins({ extraIds = [] } = {}) {
  const ids = new Set();

  // 1. Deterministic unpacked IDs for repoRoot and its realpath
  ids.add(computeUnpackedExtensionId(repoRoot));
  try {
    ids.add(computeUnpackedExtensionId(realpathSync(repoRoot)));
  } catch {}

  // 2. CLI / env extra IDs
  for (const raw of extraIds) {
    const clean = String(raw || '').trim().replace(/^chrome-extension:\/\//, '').replace(/\/$/, '');
    if (/^[a-p]{32}$/.test(clean)) ids.add(clean);
  }

  // 3. Scan local dev profile and standard browser profiles across macOS, Linux, and Windows
  const home = homedir();
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const profileRoots = [
    join(repoRoot, '.test-profile'),
    join(repoRoot, '.chrome-dev-profile'),
    // macOS
    join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
    join(home, 'Library', 'Application Support', 'Chromium'),
    join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
    join(home, 'Library', 'Application Support', 'Arc', 'User Data'),
    // Linux
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'chromium'),
    join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
    // Windows
    join(localAppData, 'Google', 'Chrome', 'User Data'),
    join(localAppData, 'Chromium', 'User Data'),
    join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    join(localAppData, 'Microsoft', 'Edge', 'User Data'),
  ];
  for (const root of profileRoots) {
    for (const id of discoverExtensionIdsFromProfileDir(root)) {
      ids.add(id);
    }
  }

  return [...ids].map(id => `chrome-extension://${id}/`);
}

export function getTargetHostDirs({ includeDevProfile = true } = {}) {
  const home = homedir();
  const os = platform();
  const dirs = [];

  if (os === 'darwin') {
    dirs.push(
      join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
      join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary', 'NativeMessagingHosts'),
      join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
      join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      join(home, 'Library', 'Application Support', 'Arc', 'User Data', 'NativeMessagingHosts'),
    );
  } else if (os === 'linux') {
    dirs.push(
      join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
      join(home, '.config', 'chromium', 'NativeMessagingHosts'),
      join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    );
  } else if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    dirs.push(join(localAppData, 'InvoiceExtractor', 'NativeMessagingHosts'));
  }

  if (includeDevProfile) {
    dirs.push(join(repoRoot, '.test-profile', 'NativeMessagingHosts'));
  }

  return dirs;
}

export function installNativeMessagingHost({ extraIds = [], targetDirs = null } = {}) {
  try {
    chmodSync(join(repoRoot, 'scripts', 'onepassword-host.sh'), 0o755);
    chmodSync(join(repoRoot, 'scripts', 'onepassword-host.mjs'), 0o755);
  } catch {}

  const allowedOrigins = collectAllowedOrigins({ extraIds });
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Invoice Extractor 1Password Service Account Native Messaging Host',
    path: hostScriptPath,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  };

  const dirs = targetDirs || getTargetHostDirs();
  const written = [];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    written.push(file);
  }

  // On Windows, register HKCU NativeMessagingHosts keys pointing to the written manifest
  if (platform() === 'win32' && written.length > 0 && !targetDirs) {
    const winManifestPath = written[0];
    const regKeys = [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    ];
    for (const key of regKeys) {
      try {
        execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', winManifestPath, '/f'], {
          stdio: 'ignore',
        });
      } catch {}
    }
  }

  return {
    hostName: NATIVE_HOST_NAME,
    hostScriptPath,
    allowedOrigins,
    written,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const extraIds = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  if (process.env.EXTENSION_ID) extraIds.push(process.env.EXTENSION_ID);
  const result = installNativeMessagingHost({ extraIds });
  console.log(JSON.stringify(result, null, 2));
}
