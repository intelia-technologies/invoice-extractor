#!/usr/bin/env node
/**
 * Agent-First CLI for Invoice Extractor.
 *
 * Shares the declarative catalog (`providers/*.json`), in-page DOM engine (`engine.js` + `utils.js`),
 * 1Password Service Account resolver (`onepassword.mjs`), and local state (`~/.config/invoice-extractor/state.json`)
 * with the Chrome extension.
 *
 * Usage:
 *   invoice-extractor status
 *   invoice-extractor providers
 *   invoice-extractor profiles [--sync-1p]
 *   invoice-extractor config set --profile Acme --provider stripe --key accountId --value acct_123
 *   invoice-extractor op-save --vault personal --title "Stripe Acme" --url "https://dashboard.stripe.com" --username "billing@acme.com" --tags "Acme"
 *   invoice-extractor run --profile Acme [--providers holded,stripe] [--since 2026-09-01] [--max 50] [--out ./invoices] [--headed]
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractConfigFromUrls } from '../onepassword.mjs';
import {
  handleHostRequest,
  loadServiceAccountTokens,
  readLocalState,
  resolveBwBinary,
  resolveOpBinary,
  writeLocalState,
} from '../scripts/onepassword-host.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

export function loadAllProviders(rootDir = ROOT_DIR) {
  const indexPath = join(rootDir, 'providers', 'index.json');
  const ids = JSON.parse(readFileSync(indexPath, 'utf8'));
  return ids.map(id => {
    const pPath = join(rootDir, 'providers', `${id}.json`);
    return JSON.parse(readFileSync(pPath, 'utf8'));
  });
}

export function isConfigFieldRequiredForNavigation(provider, key) {
  if (provider.id === 'stripe' && key === 'accountId') return false;
  const token = `{{config.${key}}}`;
  if (String(provider.billingUrl || '').includes(token)) return true;
  if (String(provider.preNavigation?.url || '').includes(token)) return true;
  return false;
}

export function resolveConfigTemplate(template, provider, providerConfig = {}) {
  if (!template) return template;
  let out = String(template);
  for (const [key, def] of Object.entries(provider.config || {})) {
    const raw = providerConfig[key];
    const scalar = Array.isArray(raw) ? raw.filter(Boolean)[0] : raw;
    const value = scalar || def?.default || '';
    out = out.replace(new RegExp(`\\{\\{config\\.${key}\\}\\}`, 'g'), String(value));
  }
  return out;
}

export function resolveBillingUrl(provider, providerConfig = {}) {
  const raw = resolveConfigTemplate(provider.billingUrl, provider, providerConfig);
  return typeof raw === 'string' ? raw.replace(/([^:]\/)\/+/g, '$1') : raw;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] || 'status', subcommand: positional[1] || '', positional, flags };
}

export async function syncProfilesFrom1PasswordToState(providers, deps = {}) {
  const discoveredRes = await handleHostRequest(
    {
      action: 'discoverProfiles',
      providers: providers.map(p => ({
        id: p.id,
        name: p.name,
        billingUrl: p.billingUrl,
        config: p.config || null,
        auth: p.auth || null,
      })),
      vaultHint: deps.vaultHint || '',
    },
    deps
  );

  const state = writeLocalState(
    { profiles: discoveredRes.profiles || [] },
    { merge: true },
    deps
  );

  return {
    totalItemsScanned: discoveredRes.totalItems || 0,
    discoveredProfiles: discoveredRes.profiles || [],
    profiles: state.profiles,
    statePath: state.statePath,
  };
}

export function setProfileOrProviderConfig(
  { profileName = '', providerId, key, value, opItem = '' },
  deps = {}
) {
  if (!providerId) throw new Error('--provider <id> is required.');
  const current = readLocalState(deps);
  const profiles = [...(current.profiles || [])];
  const providerConfigs = { ...(current.providerConfigs || {}) };

  const patchObj = {};
  if (key) patchObj[key] = value;
  if (opItem) patchObj._onepasswordItem = opItem;

  providerConfigs[providerId] = {
    ...(providerConfigs[providerId] || {}),
    ...patchObj,
  };

  let targetProfile = null;
  if (profileName) {
    const slug = profileName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    targetProfile = profiles.find(
      p => p.id === slug || String(p.name || '').trim().toLowerCase() === profileName.trim().toLowerCase()
    );
    if (!targetProfile) {
      targetProfile = {
        id: slug,
        name: profileName.trim(),
        activeProviders: [providerId],
        configs: { [providerId]: { ...patchObj } },
      };
      profiles.push(targetProfile);
    } else {
      if (!targetProfile.activeProviders?.includes(providerId)) {
        targetProfile.activeProviders = [...(targetProfile.activeProviders || []), providerId];
      }
      targetProfile.configs = {
        ...(targetProfile.configs || {}),
        [providerId]: {
          ...(targetProfile.configs?.[providerId] || {}),
          ...patchObj,
        },
      };
    }
  }

  const saved = writeLocalState({ profiles, providerConfigs }, { merge: true }, deps);
  return {
    updatedProfile: targetProfile?.name || null,
    providerId,
    config: targetProfile ? targetProfile.configs[providerId] : saved.providerConfigs[providerId],
    statePath: saved.statePath,
  };
}

async function injectEngineIntoFrame(frame, rootDir = ROOT_DIR) {
  const utilsCode = readFileSync(join(rootDir, 'utils.js'), 'utf8');
  const engineCode = readFileSync(join(rootDir, 'engine.js'), 'utf8');
  await frame.evaluate(code => {
    if (!window.__invoiceUtils) (0, eval)(code);
  }, utilsCode);
  await frame.evaluate(code => {
    if (!window.__invoiceEngine) (0, eval)(code);
  }, engineCode);
}

async function resolveTargetFrame(page, provider, timeoutMs = 10000) {
  if (!provider.iframe?.urlPattern) return page.mainFrame();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = page.frames().find(f => f !== page.mainFrame() && f.url().includes(provider.iframe.urlPattern));
    if (found) return found;
    // Break early if main frame shows a login form
    try {
      await injectEngineIntoFrame(page.mainFrame());
      const det = await page.mainFrame().evaluate(authCfg => window.__invoiceEngine.detectLoginForm(authCfg), provider.auth || {});
      if (det?.hasLoginForm) return page.mainFrame();
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return page.mainFrame();
}

async function waitForSelectorInFrame(page, provider, selector, timeoutSec = 10) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    try {
      const frame = await resolveTargetFrame(page, provider, 1500);
      await injectEngineIntoFrame(frame);
      const exists = await frame.evaluate(sel => window.__invoiceEngine.queryElement(sel), selector);
      if (exists) return { success: true, frame };
    } catch {}
    await new Promise(r => setTimeout(r, 700));
  }
  return { success: false, frame: page.mainFrame() };
}

export async function runAgentExtraction(options = {}, deps = {}) {
  const {
    profileName = '',
    providerIds = [],
    sinceDate = null,
    maxInvoices = 999,
    outDir = resolve(process.cwd(), 'downloads'),
    headed = false,
    userDataDir = join(homedir(), '.config', 'invoice-extractor', 'browser-profile'),
    skipDedup = false,
  } = options;

  const allProviders = loadAllProviders();
  let state = readLocalState(deps);

  // Auto-discover from 1Password if requested profile is not in state yet
  let activeProfile = null;
  if (profileName) {
    const findProfile = list =>
      list.find(
        p =>
          p.id === profileName.toLowerCase() ||
          String(p.name || '').trim().toLowerCase() === profileName.trim().toLowerCase()
      );
    activeProfile = findProfile(state.profiles || []);
    if (!activeProfile) {
      const synced = await syncProfilesFrom1PasswordToState(allProviders, deps);
      state = readLocalState(deps);
      activeProfile = findProfile(synced.profiles || []);
    }
    if (!activeProfile) {
      throw new Error(
        `Profile "${profileName}" not found in local state or 1Password tags. Run: invoice-extractor profiles --sync-1p`
      );
    }
  }

  const selectedIds =
    providerIds.length > 0
      ? providerIds
      : activeProfile?.activeProviders?.length
      ? activeProfile.activeProviders
      : allProviders.map(p => p.id);

  const targetProviders = allProviders.filter(p => selectedIds.includes(p.id));
  mkdirSync(outDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });

  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !headed,
    acceptDownloads: true,
    viewport: { width: 1366, height: 900 },
  });

  const manifest = {
    profile: activeProfile?.name || null,
    outDir,
    sinceDate,
    startedAt: new Date().toISOString(),
    downloadedFiles: [],
    learnedConfigs: {},
    skippedProviders: [],
    errors: [],
  };

  try {
    const page = context.pages()[0] || (await context.newPage());

    for (const provider of targetProviders) {
      const provConfig = {
        ...(state.providerConfigs?.[provider.id] || {}),
        ...(activeProfile?.configs?.[provider.id] || {}),
      };

      // Check required URL config fields
      const missingRequired = Object.keys(provider.config || {}).filter(key => {
        if (!isConfigFieldRequiredForNavigation(provider, key)) return false;
        const val = provConfig[key] || provider.config[key]?.default || '';
        return !String(val).trim();
      });

      if (missingRequired.length > 0) {
        manifest.skippedProviders.push({
          providerId: provider.id,
          reason: `Missing required URL config field(s): ${missingRequired.join(', ')}`,
        });
        continue;
      }

      const billingUrl = resolveBillingUrl(provider, provConfig);
      try {
        await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      } catch {}

      let readyCheck = await waitForSelectorInFrame(page, provider, provider.readySelector, 6);

      // Resolve 1Password credentials for login or account verification
      let creds = null;
      try {
        creds = await handleHostRequest(
          {
            action: 'resolveProvider',
            provider,
            billingUrl,
            itemOverride: provConfig._onepasswordItem || '',
            profileName: activeProfile?.name || profileName || '',
            providerConfig: provConfig,
          },
          deps
        );
      } catch {}

      if (!readyCheck.success && creds) {
        await injectEngineIntoFrame(page.mainFrame());
        const loginRes = await page
          .mainFrame()
          .evaluate(
            ([c, authCfg]) => window.__invoiceEngine.attemptAutoLogin(c, authCfg),
            [creds, provider.auth || {}]
          );

        if (loginRes?.attempted) {
          await page.waitForTimeout(4000);
          const currentUrl = page.url();
          if (!currentUrl.includes(new URL(billingUrl).pathname)) {
            try {
              await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            } catch {}
          } else if (billingUrl.includes('#')) {
            try {
              await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
            } catch {}
          }
          readyCheck = await waitForSelectorInFrame(page, provider, provider.readySelector, 12);
        }
      }

      // If ready, verify identity matches expected 1Password credentials
      if (readyCheck.success && creds) {
        const previousOwner = state.sessionOwners?.[provider.id];
        await injectEngineIntoFrame(page.mainFrame());
        const idCheck = await page.mainFrame().evaluate(
          ([expected, authCfg]) => window.__invoiceEngine.verifyLoggedInIdentity(expected, authCfg),
          [
            {
              username: creds.username || '',
              previousUsername: previousOwner?.username || '',
            },
            provider.auth || {},
          ]
        );

        const ownerMismatch = Boolean(
          previousOwner?.itemId && creds.itemId && previousOwner.itemId !== creds.itemId
        );

        if (ownerMismatch || idCheck?.mismatchDetected) {
          // Perform logout + re-login
          await page.mainFrame().evaluate(() => window.__invoiceEngine.clearPageSessionData());
          await context.clearCookies();
          if (provider.auth?.logoutUrl) {
            try {
              await page.goto(provider.auth.logoutUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            } catch {}
          }
          try {
            await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          } catch {}
          await injectEngineIntoFrame(page.mainFrame());
          await page
            .mainFrame()
            .evaluate(
              ([c, authCfg]) => window.__invoiceEngine.attemptAutoLogin(c, authCfg),
              [creds, provider.auth || {}]
            );
          await page.waitForTimeout(4000);
          try {
            await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            if (billingUrl.includes('#')) await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
          } catch {}
          readyCheck = await waitForSelectorInFrame(page, provider, provider.readySelector, 12);
        }

        if (readyCheck.success) {
          state = writeLocalState(
            {
              sessionOwners: {
                [provider.id]: {
                  itemId: creds.itemId,
                  username: (creds.username || '').toLowerCase(),
                  profileId: activeProfile?.id || null,
                  updatedAt: Date.now(),
                },
              },
            },
            { merge: true },
            deps
          );
        }
      }

      if (!readyCheck.success) {
        manifest.errors.push({
          providerId: provider.id,
          error: 'Billing page readySelector not reached (check login or 2FA challenge). Run with --headed to inspect.',
        });
        continue;
      }

      // Auto-learn URL parameters (e.g. Stripe acct_... from redirected URL) and persist back to state!
      const learned = extractConfigFromUrls([page.url()], provider);
      for (const [k, v] of Object.entries(learned)) {
        if (!provConfig[k] && v) {
          setProfileOrProviderConfig(
            {
              profileName: activeProfile?.name || profileName,
              providerId: provider.id,
              key: k,
              value: v,
            },
            deps
          );
          manifest.learnedConfigs[`${provider.id}.${k}`] = v;
        }
      }

      const targetFrame = readyCheck.frame;
      await injectEngineIntoFrame(targetFrame);

      // Run extract.preSteps if defined
      for (const step of provider.extract?.preSteps || []) {
        if (step.action === 'diagnose') continue;
        try {
          await targetFrame.evaluate(s => window.__invoiceEngine.executeStep(s), step);
        } catch {}
      }

      // Extract rows
      const previousDownloads = skipDedup
        ? []
        : (state.history || [])
            .filter(h => String(h).startsWith(`${provider.id}::`))
            .map(h => String(h).slice(`${provider.id}::`.length));

      const extraction = await targetFrame.evaluate(
        ([prov, cfg]) => window.__invoiceEngine.extractRows(prov, cfg),
        [
          provider,
          {
            maxInvoices,
            sinceDate,
            previousDownloads,
            seen: [],
          },
        ]
      );

      const invoices = extraction?.invoices || [];
      const newHistoryKeys = [];

      for (const inv of invoices) {
        const filename = (inv.filename || `${provider.id}_${inv.date || 'invoice'}.pdf`).replace(/[/\\?%*:|"<>]/g, '_');
        const destPath = join(outDir, filename);

        let downloaded = false;
        try {
          if (inv.downloadUrl && (provider.download.method === 'direct-link' || provider.download.method === 'fetch-blob')) {
            const b64 = await targetFrame.evaluate(async url => {
              const res = await fetch(url, { credentials: 'include' });
              if (!res.ok) return null;
              const blob = await res.blob();
              return new Promise(resolve => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
              });
            }, inv.downloadUrl);

            if (b64 && b64.includes(',')) {
              const buf = Buffer.from(b64.split(',')[1], 'base64');
              writeFileSync(destPath, buf);
              downloaded = true;
            }
          }

          if (!downloaded && provider.download.method === 'click-download') {
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: 12000 }).catch(() => null),
              targetFrame.evaluate(
                ([rowSel, rowIdx, steps]) => window.__invoiceEngine.clickInRow(rowSel, rowIdx, steps),
                [provider.extract.rows, inv.__rowIndex, provider.download.steps || []]
              ),
            ]);
            if (download) {
              await download.saveAs(destPath);
              downloaded = true;
            }
          }
        } catch (dlErr) {
          manifest.errors.push({ providerId: provider.id, filename, error: dlErr.message });
        }

        if (downloaded) {
          const dedupVal =
            inv[provider.extract?.dedup || 'downloadUrl'] ||
            inv.downloadUrl ||
            inv.id ||
            inv.invoiceNumber ||
            filename;
          newHistoryKeys.push(`${provider.id}::${dedupVal}`);
          manifest.downloadedFiles.push({
            providerId: provider.id,
            filename,
            path: destPath,
            date: inv.date || null,
            amount: inv.amount || null,
            invoiceNumber: inv.invoiceNumber || inv.id || null,
          });
        }
      }

      if (newHistoryKeys.length > 0) {
        state = writeLocalState({ history: newHistoryKeys }, { merge: true }, deps);
      }
    }
  } finally {
    await context.close();
  }

  manifest.completedAt = new Date().toISOString();
  return manifest;
}

async function injectRecorderIntoFrame(frame, rootDir = ROOT_DIR) {
  const recorderCode = readFileSync(join(rootDir, 'recorder.js'), 'utf8');
  await frame.evaluate(code => {
    if (!window.__invoiceRecorder) (0, eval)(code);
  }, recorderCode);
}

export async function inspectBillingPage(options = {}, deps = {}) {
  const {
    url,
    profileName = '',
    itemOverride = '',
    vaultHint = '',
    clickSelectors = [],
    waitMs = 2500,
    headed = false,
    outFile = null,
    userDataDir = join(homedir(), '.config', 'invoice-extractor', 'browser-profile'),
  } = options;

  if (!url) {
    throw new Error('--url <billingUrl> is required for inspect.');
  }

  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !headed,
    acceptDownloads: true,
    viewport: { width: 1366, height: 900 },
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch {}
    await page.waitForTimeout(1500);

    // Check if login form is visible and sign in via 1Password if available
    await injectEngineIntoFrame(page.mainFrame());
    const loginDet = await page
      .mainFrame()
      .evaluate(() => window.__invoiceEngine.detectLoginForm({}))
      .catch(() => null);

    let signedInWith1Password = false;
    let resolvedItemTitle = null;

    if (loginDet?.hasLoginForm || itemOverride || profileName) {
      let creds = null;
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        creds = await handleHostRequest(
          {
            action: 'resolveProvider',
            provider: {
              id: hostname.split('.')[0],
              name: hostname.split('.')[0],
              billingUrl: url,
            },
            billingUrl: url,
            itemOverride,
            vaultHint,
            profileName,
          },
          deps
        );
      } catch {}

      if (creds && loginDet?.hasLoginForm) {
        resolvedItemTitle = creds.title || null;
        const loginRes = await page
          .mainFrame()
          .evaluate(c => window.__invoiceEngine.attemptAutoLogin(c, {}), creds)
          .catch(() => null);

        if (loginRes?.attempted) {
          signedInWith1Password = true;
          await page.waitForTimeout(4000);
          if (page.url() !== url) {
            try {
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
              if (url.includes('#')) {
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
              }
            } catch {}
            await page.waitForTimeout(2000);
          }
        }
      }
    }

    // Inject recorder into main frame and start recording
    await injectRecorderIntoFrame(page.mainFrame());
    await page.mainFrame().evaluate(() => window.__invoiceRecorder.start());

    // Optional pre-inspection clicks (e.g. switching to an "Invoices" tab)
    for (const sel of clickSelectors) {
      try {
        await injectEngineIntoFrame(page.mainFrame());
        await page
          .mainFrame()
          .evaluate(selector => window.__invoiceEngine.executeStep({ action: 'click', selector, wait: 1500 }), sel);
      } catch {}
    }

    // Inject recorder into any child iframes
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        await injectRecorderIntoFrame(frame);
        await frame.evaluate(() => window.__invoiceRecorder.start());
      } catch {}
    }

    await page.waitForTimeout(waitMs);

    // Stop recorder on main frame and collect analysis
    const mainStop = await page
      .mainFrame()
      .evaluate(() => window.__invoiceRecorder.stop())
      .catch(() => null);

    const favIconUrl = await page
      .mainFrame()
      .evaluate(() => {
        const link = document.querySelector('link[rel*="icon"][href]');
        if (link?.href) return link.href;
        return new URL('/favicon.ico', location.origin).href;
      })
      .catch(() => null);

    // Collect analysis from any child iframes
    const iframes = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        await injectRecorderIntoFrame(frame);
        const fStop = await frame.evaluate(() => {
          window.__invoiceRecorder.start();
          return window.__invoiceRecorder.stop();
        });
        const fData = fStop?.data;
        if (
          fData &&
          ((fData.analysis?.invoiceTableCandidates?.length || 0) > 0 ||
            (fData.analysis?.paginationCandidates?.length || 0) > 0)
        ) {
          iframes.push({
            frameUrl: frame.url(),
            pageTitle: fData.pageTitle,
            analysis: fData.analysis,
            domSnapshots: fData.domSnapshots,
          });
        }
      } catch {}
    }

    const fullRecording = {
      ...(mainStop?.data || {}),
      billingUrl: page.url(),
      favIconUrl,
      signedInWith1Password,
      resolvedItemTitle,
      iframes,
    };

    if (outFile) {
      const outPath = resolve(process.cwd(), String(outFile));
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(fullRecording, null, 2)}\n`, 'utf8');
    }

    return {
      billingUrl: fullRecording.billingUrl,
      pageTitle: fullRecording.pageTitle || '',
      favIconUrl,
      signedInWith1Password,
      resolvedItemTitle,
      savedRecordingPath: outFile ? resolve(process.cwd(), String(outFile)) : null,
      analysis: fullRecording.analysis || {},
      iframes: iframes.map(f => ({
        frameUrl: f.frameUrl,
        analysis: f.analysis,
      })),
    };
  } finally {
    await context.close();
  }
}

export async function onboardProvider(options = {}, deps = {}) {
  const {
    target = '',
    url = '',
    profileName = '',
    vaultHint = '',
    headed = false,
    outDir = resolve(process.cwd(), 'downloads'),
  } = options;

  if (!target && !url) {
    throw new Error('Provide --provider <name|id> or --url <billingUrl> to onboard.');
  }

  const allProviders = loadAllProviders();
  await syncProfilesFrom1PasswordToState(allProviders, { ...deps, vaultHint });

  const normalizedTarget = String(target || '').trim().toLowerCase();
  const existingProvider = allProviders.find(p => {
    if (normalizedTarget && (p.id.toLowerCase() === normalizedTarget || p.name.toLowerCase() === normalizedTarget)) {
      return true;
    }
    if (url) {
      try {
        const uHost = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
        const pHost = new URL(p.billingUrl.replace(/\{\{config\.\w+\}\}/g, 'app')).hostname
          .replace(/^www\./, '')
          .toLowerCase();
        return uHost === pHost || uHost.endsWith(`.${pHost}`) || pHost.endsWith(`.${uHost}`);
      } catch {}
    }
    return false;
  });

  // Case 1: Provider already exists in catalog -> test it with 1Password credentials (max 1 invoice)
  if (existingProvider) {
    const testRun = await runAgentExtraction(
      {
        profileName,
        providerIds: [existingProvider.id],
        maxInvoices: 1,
        outDir,
        headed,
        skipDedup: true,
      },
      deps
    );

    if (testRun.downloadedFiles.length > 0 && testRun.errors.length === 0) {
      return {
        status: 'verified_existing',
        providerId: existingProvider.id,
        providerName: existingProvider.name,
        profile: testRun.profile,
        downloadedSample: testRun.downloadedFiles[0],
        learnedConfigs: testRun.learnedConfigs,
      };
    }

    // Existing provider failed -> auto-run inspect so the agent can repair the recipe and re-verify
    const targetUrl = url || resolveBillingUrl(existingProvider, {});
    const inspection = await inspectBillingPage(
      {
        url: targetUrl,
        profileName,
        vaultHint,
        headed,
      },
      deps
    );

    return {
      status: 'needs_repair',
      providerId: existingProvider.id,
      providerName: existingProvider.name,
      failureReasons: [
        ...testRun.errors.map(e => e.error),
        ...testRun.skippedProviders.map(s => s.reason),
      ],
      inspection,
    };
  }

  // Case 2: Provider does NOT exist in catalog yet -> find its URL in 1Password if not passed, then inspect
  let targetUrl = url;
  let matchedOpItem = null;
  if (!targetUrl) {
    const itemsRes = await handleHostRequest({ action: 'listItems', vaultHint }, deps);
    matchedOpItem = (itemsRes.items || []).find(it =>
      String(it.title || '').toLowerCase().includes(normalizedTarget)
    );
    targetUrl = matchedOpItem?.urls?.[0] || '';
  }

  if (!targetUrl) {
    throw new Error(
      `Provider "${target}" is not in the catalog and no URL was found in 1Password. Pass --url <billingUrl>.`
    );
  }

  const suggestedId =
    normalizedTarget.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ||
    new URL(targetUrl).hostname.replace(/^(www|app|dashboard|billing)\./, '').split('.')[0];

  const inspection = await inspectBillingPage(
    {
      url: targetUrl,
      profileName,
      itemOverride: matchedOpItem?.id || target,
      vaultHint,
      headed,
    },
    deps
  );

  return {
    status: 'needs_creation',
    suggestedId,
    targetUrl,
    matched1PasswordItem: matchedOpItem?.title || inspection.resolvedItemTitle || null,
    inspection,
  };
}

export function getClaudeDesktopConfigPath() {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

export function registerClaudeDesktopMcp({ configPath = getClaudeDesktopConfigPath() } = {}) {
  mkdirSync(dirname(configPath), { recursive: true });
  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      existing = {};
    }
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== 'object') {
    existing.mcpServers = {};
  }
  existing.mcpServers['invoice-extractor'] = {
    command: process.execPath,
    args: [join(ROOT_DIR, 'bin', 'invoice-extractor-mcp.mjs')],
  };
  writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return configPath;
}

function getNativeHostManifestPath() {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(
      home,
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
      'com.intelia.invoice_extractor.op.json'
    );
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(
      localAppData,
      'InvoiceExtractor',
      'NativeMessagingHosts',
      'com.intelia.invoice_extractor.op.json'
    );
  }
  return join(
    home,
    '.config',
    'google-chrome',
    'NativeMessagingHosts',
    'com.intelia.invoice_extractor.op.json'
  );
}

function promptSecretCrossPlatform(promptMsg) {
  if (process.platform === 'darwin') {
    const osaScript = `text returned of (display dialog ${JSON.stringify(
      promptMsg
    )} default answer "" with title "Invoice Extractor — 1Password Setup" with hidden answer)`;
    return execFileSync('osascript', ['-e', osaScript], { encoding: 'utf8' }).trim();
  }
  if (process.platform === 'win32') {
    const psScript = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox(${JSON.stringify(
      promptMsg
    )}, "Invoice Extractor — 1Password Setup", "")`;
    return execFileSync('powershell', ['-NoProfile', '-Command', psScript], {
      encoding: 'utf8',
    }).trim();
  }
  // Linux: try zenity or kdialog
  try {
    return execFileSync(
      'zenity',
      ['--password', '--title=Invoice Extractor — 1Password Setup', `--text=${promptMsg}`],
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return execFileSync(
      'kdialog',
      ['--password', promptMsg, '--title', 'Invoice Extractor — 1Password Setup'],
      { encoding: 'utf8' }
    ).trim();
  }
}

export async function runDoctor({ fix = false, manager = '' } = {}, deps = {}) {
  const checks = [];
  const actionsTaken = [];
  const tokens = loadServiceAccountTokens(deps);
  const localState = readLocalState(deps);
  const activeManager =
    (manager || localState.passwordManager || (tokens.BW_SESSION ? 'bitwarden' : '1password')).toLowerCase();

  // 1. Check node_modules (playwright + ajv)
  let nodeModulesOk =
    existsSync(join(ROOT_DIR, 'node_modules', 'playwright')) &&
    existsSync(join(ROOT_DIR, 'node_modules', 'ajv'));
  if (!nodeModulesOk && fix) {
    try {
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], {
        cwd: ROOT_DIR,
        stdio: 'ignore',
      });
      actionsTaken.push('Ran npm install');
      nodeModulesOk = existsSync(join(ROOT_DIR, 'node_modules', 'playwright'));
    } catch {}
  }
  checks.push({
    id: 'node_modules',
    ok: nodeModulesOk,
    fixCommand: 'npm install',
  });

  // 2. Check Playwright Chromium binary
  let chromiumOk = false;
  let chromiumPath = null;
  try {
    const { chromium } = await import('playwright');
    chromiumPath = chromium.executablePath();
    chromiumOk = Boolean(chromiumPath && existsSync(chromiumPath));
  } catch {}
  if (!chromiumOk && fix) {
    try {
      execFileSync(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['playwright', 'install', 'chromium'],
        { cwd: ROOT_DIR, stdio: 'ignore' }
      );
      actionsTaken.push('Installed Playwright Chromium browser');
      const { chromium } = await import('playwright');
      chromiumPath = chromium.executablePath();
      chromiumOk = Boolean(chromiumPath && existsSync(chromiumPath));
    } catch {}
  }
  checks.push({
    id: 'playwright_chromium',
    ok: chromiumOk,
    executablePath: chromiumPath,
    fixCommand: 'npx playwright install chromium',
  });

  // 3. Check Password Manager CLI (1Password `op` OR Bitwarden `bw`) across macOS, Windows, and Linux
  if (activeManager === 'bitwarden') {
    let bwBin = resolveBwBinary();
    let bwOk = false;
    let bwVersion = null;
    try {
      bwVersion = execFileSync(bwBin, ['--version'], { encoding: 'utf8' }).trim();
      bwOk = Boolean(bwVersion);
    } catch {}
    if (!bwOk && fix) {
      try {
        if (process.platform === 'darwin') {
          execFileSync('brew', ['install', 'bitwarden-cli'], { stdio: 'ignore' });
        } else if (process.platform === 'win32') {
          execFileSync(
            'winget',
            [
              'install',
              '-e',
              '--id',
              'Bitwarden.CLI',
              '--accept-source-agreements',
              '--accept-package-agreements',
            ],
            { stdio: 'ignore' }
          );
        } else if (process.platform === 'linux') {
          execFileSync('snap', ['install', 'bw'], { stdio: 'ignore' });
        }
        actionsTaken.push(`Installed bitwarden-cli (${process.platform})`);
        bwBin = resolveBwBinary();
        bwVersion = execFileSync(bwBin, ['--version'], { encoding: 'utf8' }).trim();
        bwOk = Boolean(bwVersion);
      } catch {}
    }
    const bwFixCmd =
      process.platform === 'darwin'
        ? 'brew install bitwarden-cli'
        : process.platform === 'win32'
        ? 'winget install -e --id Bitwarden.CLI'
        : 'sudo snap install bw';
    checks.push({
      id: 'bitwarden_cli',
      ok: bwOk,
      binary: bwBin,
      version: bwVersion,
      fixCommand: bwFixCmd,
    });

    const bwAuthOk = Boolean(tokens.BW_SESSION);
    checks.push({
      id: 'bitwarden_auth',
      ok: bwAuthOk,
      authMode: bwAuthOk ? 'bitwarden-session' : 'unconfigured',
      humanPermissionNeeded: !bwAuthOk
        ? 'Run "bw login && export BW_SESSION=$(bw unlock --raw)" or "node bin/invoice-extractor.mjs setup --manager bitwarden --prompt-token".'
        : null,
    });
  } else {
    let opBin = resolveOpBinary();
    let opOk = false;
    let opVersion = null;
    try {
      opVersion = execFileSync(opBin, ['--version'], { encoding: 'utf8' }).trim();
      opOk = Boolean(opVersion);
    } catch {}
    if (!opOk && fix) {
      try {
        if (process.platform === 'darwin') {
          execFileSync('brew', ['install', '--cask', '1password-cli'], { stdio: 'ignore' });
        } else if (process.platform === 'win32') {
          execFileSync(
            'winget',
            [
              'install',
              '-e',
              '--id',
              'AgileBits.1Password.CLI',
              '--accept-source-agreements',
              '--accept-package-agreements',
            ],
            { stdio: 'ignore' }
          );
        } else if (process.platform === 'linux') {
          execFileSync('snap', ['install', '1password-cli'], { stdio: 'ignore' });
        }
        actionsTaken.push(`Installed 1password-cli (${process.platform})`);
        opBin = resolveOpBinary();
        opVersion = execFileSync(opBin, ['--version'], { encoding: 'utf8' }).trim();
        opOk = Boolean(opVersion);
      } catch {}
    }
    const opFixCmd =
      process.platform === 'darwin'
        ? 'brew install --cask 1password-cli'
        : process.platform === 'win32'
        ? 'winget install -e --id AgileBits.1Password.CLI'
        : 'sudo snap install 1password-cli';
    checks.push({
      id: 'onepassword_cli',
      ok: opOk,
      binary: opBin,
      version: opVersion,
      fixCommand: opFixCmd,
    });

    // 4. Check 1Password Auth (Service Account Token OR Desktop App Biometrics)
    const configuredTokenKeys = Object.keys(tokens).filter(k => k !== 'BW_SESSION');
    const hasDesktopVaults = (localState.vaults || []).some(v => v.desktopBiometrics);
    const authOk = configuredTokenKeys.length > 0 || hasDesktopVaults;
    checks.push({
      id: 'onepassword_auth',
      ok: authOk,
      authMode:
        configuredTokenKeys.length > 0
          ? 'service-account'
          : hasDesktopVaults
          ? 'desktop-biometrics'
          : 'unconfigured',
      configuredVariables: configuredTokenKeys,
      configuredVaults: (localState.vaults || []).map(v => v.vault),
      humanPermissionNeeded: !authOk
        ? 'Run "node bin/invoice-extractor.mjs setup --mode desktop --vault Personal" (for 1Password Desktop Touch ID / Windows Hello) OR "node bin/invoice-extractor.mjs setup --prompt-token" (for Service Account Token via native dialog).'
        : null,
    });
  }

  // 5. Check Chrome Native Messaging Host manifest
  const manifestPath = getNativeHostManifestPath();
  let nativeHostOk = existsSync(manifestPath);
  if (!nativeHostOk && fix) {
    try {
      execFileSync(process.execPath, [join(ROOT_DIR, 'scripts', 'install-onepassword-host.mjs')], {
        cwd: ROOT_DIR,
        stdio: 'ignore',
      });
      actionsTaken.push('Registered Chrome Native Messaging Host');
      nativeHostOk = existsSync(manifestPath);
    } catch {}
  }
  checks.push({
    id: 'chrome_native_host',
    ok: nativeHostOk,
    manifestPath,
    fixCommand: 'npm run install:1password',
  });

  const allOk = checks.every(c => c.ok);
  return {
    ready: allOk,
    platform: process.platform,
    passwordManager: activeManager,
    checks,
    actionsTaken,
  };
}

export async function runSetup(
  {
    manager = '1password', // '1password' | 'bitwarden'
    vault = 'AI',
    mode = '', // 'service-account' | 'desktop' | 'bitwarden-session'
    tokenEnv = 'OP_SERVICE_ACCOUNT_TOKEN_INTELIA',
    promptToken = false,
    installMcp = true,
  } = {},
  deps = {}
) {
  const normalizedManager = String(manager || '1password').toLowerCase() === 'bitwarden' ? 'bitwarden' : '1password';

  // 1. Auto-install any missing technical dependencies
  await runDoctor({ fix: true, manager: normalizedManager }, deps);

  const tokens = loadServiceAccountTokens(deps);
  let tokenSaved = false;

  if (normalizedManager === 'bitwarden') {
    if (promptToken || !tokens.BW_SESSION) {
      const promptMsg =
        'Introduce tu clave de sesión de Bitwarden (BW_SESSION obtenida con "bw unlock --raw"). Se guardará localmente sin pasar por el chat del agente:';
      const entered = promptSecretCrossPlatform(promptMsg);
      if (entered) {
        const credsPath =
          deps.credentialsEnvPath || join(homedir(), '.config', 'invoice-extractor', 'credentials.env');
        mkdirSync(dirname(credsPath), { recursive: true, mode: 0o700 });
        appendFileSync(credsPath, `\nexport BW_SESSION="${entered.replace(/"/g, '\\"')}"\n`, 'utf8');
        try {
          chmodSync(credsPath, 0o600);
        } catch {}
        if (process.platform === 'darwin') {
          const zshrcPath = deps.zshrcPath || join(homedir(), '.zshrc.local');
          appendFileSync(zshrcPath, `\nexport BW_SESSION="${entered.replace(/"/g, '\\"')}"\n`, 'utf8');
          try {
            chmodSync(zshrcPath, 0o600);
          } catch {}
        }
        tokenSaved = true;
      }
    }

    writeLocalState(
      {
        passwordManager: 'bitwarden',
        authMode: 'bitwarden-session',
      },
      { merge: true },
      deps
    );
  } else {
    const selectedMode =
      mode || (promptToken ? 'service-account' : Object.keys(tokens).filter(k => k !== 'BW_SESSION').length > 0 ? 'service-account' : 'desktop');

    // 2. If Service Account mode with prompt requested, open native OS hidden dialog
    if (selectedMode === 'service-account' && (promptToken || Object.keys(tokens).filter(k => k !== 'BW_SESSION').length === 0)) {
      const promptMsg = `Introduce el 1Password Service Account Token (ops_...) para el vault "${vault}". Se guardará localmente sin pasar por el chat del agente:`;
      const entered = promptSecretCrossPlatform(promptMsg);
      if (entered) {
        const credsPath =
          deps.credentialsEnvPath || join(homedir(), '.config', 'invoice-extractor', 'credentials.env');
        mkdirSync(dirname(credsPath), { recursive: true, mode: 0o700 });
        appendFileSync(credsPath, `\nexport ${tokenEnv}="${entered.replace(/"/g, '\\"')}"\n`, 'utf8');
        try {
          chmodSync(credsPath, 0o600);
        } catch {}
        if (process.platform === 'darwin') {
          const zshrcPath = deps.zshrcPath || join(homedir(), '.zshrc.local');
          appendFileSync(zshrcPath, `\nexport ${tokenEnv}="${entered.replace(/"/g, '\\"')}"\n`, 'utf8');
          try {
            chmodSync(zshrcPath, 0o600);
          } catch {}
        }
        tokenSaved = true;
      }
    }

    // 3. Persist the chosen vault and authMode in shared state.json
    const vaultEntry = {
      alias: vault.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      vault,
      tokenEnv: selectedMode === 'service-account' ? tokenEnv : '',
      desktopBiometrics: selectedMode === 'desktop',
    };
    writeLocalState(
      {
        passwordManager: '1password',
        vaults: [vaultEntry],
        authMode: selectedMode === 'desktop' ? 'desktop-biometrics' : 'service-account',
      },
      { merge: true },
      deps
    );
  }

  // 4. Register Claude Desktop MCP server so non-technical users have it in Claude Desktop immediately
  let claudeDesktopConfigPath = null;
  if (installMcp) {
    try {
      claudeDesktopConfigPath = registerClaudeDesktopMcp(deps);
    } catch {}
  }

  const doctorAfter = await runDoctor({ fix: false, manager: normalizedManager }, deps);
  let synced = null;
  if (doctorAfter.ready) {
    try {
      const providers = loadAllProviders();
      synced = await syncProfilesFrom1PasswordToState(providers, deps);
    } catch {}
  }

  return {
    ready: doctorAfter.ready,
    passwordManager: normalizedManager,
    authMode:
      normalizedManager === 'bitwarden'
        ? 'bitwarden-session'
        : mode === 'desktop'
        ? 'desktop-biometrics'
        : 'service-account',
    configuredVault: normalizedManager === 'bitwarden' ? 'Bitwarden' : vault,
    tokenSaved,
    claudeDesktopConfigPath,
    doctor: doctorAfter,
    syncedProfiles: synced?.profiles || [],
  };
}

async function main() {
  const { command, subcommand, flags } = parseCliArgs(process.argv.slice(2));
  const providers = loadAllProviders();

  if (command === 'doctor') {
    const res = await runDoctor({ fix: Boolean(flags.fix), manager: flags.manager || '' });
    console.log(JSON.stringify({ ok: res.ready, ...res }, null, 2));
    return;
  }

  if (command === 'setup') {
    const res = await runSetup({
      manager: flags.manager || '1password',
      vault: flags.vault || 'AI',
      mode: flags.mode || '',
      tokenEnv: flags['token-env'] || 'OP_SERVICE_ACCOUNT_TOKEN_INTELIA',
      promptToken: Boolean(flags['prompt-token']),
      installMcp: !flags['no-mcp'],
    });
    console.log(JSON.stringify({ ok: res.ready, ...res }, null, 2));
    return;
  }

  if (command === 'status') {
    const status = await handleHostRequest({ action: 'status' });
    const localState = readLocalState();
    console.log(
      JSON.stringify(
        {
          ok: true,
          onepassword: status,
          statePath: localState.statePath,
          profilesCount: localState.profiles.length,
          profiles: localState.profiles.map(p => ({
            id: p.id,
            name: p.name,
            activeProviders: p.activeProviders,
          })),
          historyCount: localState.history.length,
        },
        null,
        2
      )
    );
    return;
  }

  if (command === 'providers') {
    const list = providers.map(p => ({
      id: p.id,
      name: p.name,
      billingUrl: p.billingUrl,
      configFields: Object.entries(p.config || {}).map(([key, def]) => ({
        key,
        title: def.title,
        requiredForNavigation: isConfigFieldRequiredForNavigation(p, key),
      })),
    }));
    console.log(JSON.stringify({ ok: true, count: list.length, providers: list }, null, 2));
    return;
  }

  if (command === 'profiles') {
    if (flags['sync-1p'] || subcommand === 'sync') {
      const res = await syncProfilesFrom1PasswordToState(providers, {
        vaultHint: flags.vault || '',
      });
      console.log(JSON.stringify({ ok: true, ...res }, null, 2));
      return;
    }
    const state = readLocalState();
    console.log(
      JSON.stringify(
        {
          ok: true,
          statePath: state.statePath,
          profiles: state.profiles,
        },
        null,
        2
      )
    );
    return;
  }

  if (command === 'config' && (subcommand === 'set' || flags.provider)) {
    const res = setProfileOrProviderConfig({
      profileName: flags.profile || '',
      providerId: flags.provider,
      key: flags.key || '',
      value: flags.value ?? '',
      opItem: flags['op-item'] || '',
    });
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    return;
  }

  if (command === 'op-save') {
    const saved = await handleHostRequest({
      action: 'upsertOpItem',
      vaultHint: flags.vault || 'intelia',
      title: flags.title || '',
      url: flags.url || '',
      username: flags.username || '',
      password: flags.password || '',
      tags: flags.tags || flags.profile || '',
      notes: flags.notes || '',
    });
    const synced = await syncProfilesFrom1PasswordToState(providers);
    console.log(
      JSON.stringify(
        {
          ok: true,
          item: saved,
          profiles: synced.profiles,
        },
        null,
        2
      )
    );
    return;
  }

  if (command === 'run') {
    const providerIds = flags.providers
      ? String(flags.providers)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : [];
    const manifest = await runAgentExtraction({
      profileName: flags.profile || '',
      providerIds,
      sinceDate: flags.since || null,
      maxInvoices: flags.max ? Number(flags.max) : 999,
      outDir: flags.out ? resolve(process.cwd(), String(flags.out)) : resolve(process.cwd(), 'downloads'),
      headed: Boolean(flags.headed),
      skipDedup: Boolean(flags['skip-dedup']),
    });
    console.log(JSON.stringify({ ok: true, ...manifest }, null, 2));
    return;
  }

  if (command === 'inspect') {
    const clickSelectors = flags.click
      ? String(flags.click)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : [];
    const inspection = await inspectBillingPage({
      url: flags.url || subcommand || '',
      profileName: flags.profile || '',
      itemOverride: flags.item || flags['op-item'] || '',
      vaultHint: flags.vault || '',
      clickSelectors,
      waitMs: flags.wait ? Number(flags.wait) : 2500,
      headed: Boolean(flags.headed),
      outFile: flags.out || null,
    });
    console.log(JSON.stringify({ ok: true, ...inspection }, null, 2));
    return;
  }

  if (command === 'onboard') {
    const result = await onboardProvider({
      target: flags.provider || subcommand || '',
      url: flags.url || '',
      profileName: flags.profile || '',
      vaultHint: flags.vault || '',
      headed: Boolean(flags.headed),
      outDir: flags.out ? resolve(process.cwd(), String(flags.out)) : resolve(process.cwd(), 'downloads'),
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  });
}
