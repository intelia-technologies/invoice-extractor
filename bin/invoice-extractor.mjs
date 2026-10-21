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
 *   invoice-extractor run --profile Acme [--providers holded,stripe] [--since 2026-09-01] [--max 50] [--out ./invoices] [--headed] [--wait-for-code[=minutes]]
 *   invoice-extractor submit-code --id <verificationId> --code <code>   (or the code on stdin)
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractConfigFromUrls } from '../onepassword.mjs';
import { buildAllowedLoginDomains, describeLoginBlock, guardedAutoLogin } from '../login-domains.mjs';
import {
  handleHostRequest,
  loadServiceAccountTokens,
  readLocalState,
  resolveBwBinary,
  resolveOpBinary,
  resolveStatePath,
  writeLocalState,
} from '../scripts/onepassword-host.mjs';
import {
  clearProviderCookies,
  CODE_STEP_TTL_MS,
  createCodeMailbox,
  domainsOverlap,
  detectCodeStep,
  handOverCode,
  redactCode,
  typeVerificationCode,
  VerificationCodeError,
  waitForCodeStepExit,
} from '../scripts/verification-code.mjs';

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

function verificationRequiredMessage(provider) {
  return `${provider.name} asked for a verification code; rerun with --wait-for-code or use the extension.`;
}

// After the password: navigate to the billing page (login often lands on a dashboard) and wait
// for its readySelector.
async function reachBillingAfterLogin(page, provider, billingUrl) {
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
  return waitForSelectorInFrame(page, provider, provider.readySelector, 12);
}

function emitStderrEvent(event) {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

// CLI `run --wait-for-code`: wait for the user to type the code in the headed window, or for
// `invoice-extractor submit-code` to hand it over through a 0600 file in the state directory.
export async function waitForCodeFromCli(
  page,
  provider,
  ctx,
  step,
  { waitForCodeMs, onEvent = emitStderrEvent, acceptTimeoutMs = 20000 },
  deps
) {
  const expiresAt = new Date(Date.now() + waitForCodeMs).toISOString();
  const mailbox = createCodeMailbox(dirname(resolveStatePath(deps)), { providerId: provider.id, expiresAt });
  onEvent({
    event: 'verification_code_required',
    verificationId: mailbox.id,
    providerId: provider.id,
    providerName: provider.name,
    pageHost: new URL(page.url()).hostname,
    hint: step.hint || '',
    requestedAt: ctx.requestedAt,
    expiresAt,
    submitWith: `echo <code> | invoice-extractor submit-code --id ${mailbox.id}`,
  });
  try {
    while (Date.now() < Date.parse(expiresAt)) {
      const submission = mailbox.take();
      if (submission != null) {
        const { code: handed, nonce } = submission;
        try {
          await typeVerificationCode(page, provider, handed, {
            allowedLoginDomains: ctx.allowedLoginDomains,
            inject: injectEngineIntoFrame,
          });
          const accepted = await waitForCodeStepExit(page, provider, ctx, {
            inject: injectEngineIntoFrame,
            timeoutMs: acceptTimeoutMs,
          });
          mailbox.reply(
            {
              accepted,
              message: accepted
                ? `${provider.name} accepted the code; downloading invoices.`
                : `${provider.name} did not accept the code (still on the verification step). Check the newest email and submit again.`,
            },
            nonce
          );
          if (accepted) return true;
          onEvent({ event: 'verification_code_rejected', verificationId: mailbox.id, providerId: provider.id, expiresAt });
        } catch (err) {
          mailbox.reply({ accepted: false, message: redactCode(err.message, handed) }, nonce);
        }
        continue;
      }
      if (page.isClosed()) return false; // the user closed the window
      const left = await waitForCodeStepExit(page, provider, ctx, { inject: injectEngineIntoFrame, timeoutMs: 0 });
      if (left) return true;
      await new Promise(r => setTimeout(r, 1500));
    }
    return false;
  } finally {
    mailbox.close();
  }
}

/**
 * Right after auto-login: if the provider is asking for a one-time code (email/SMS), either wait
 * for it (CLI --wait-for-code), defer it (MCP server keeps the page open), or fail clearly.
 * Returns { status: 'none' | 'error' | 'pending', step }.
 */
async function handleVerificationStep(page, provider, ctx, run, deps) {
  const step = await detectCodeStep(page, provider, ctx, { inject: injectEngineIntoFrame });
  if (!step.awaiting) return { status: 'none' };

  if (run.verificationMode === 'wait') {
    if (await waitForCodeFromCli(page, provider, ctx, step, run, deps)) return { status: 'none' };
    run.manifest.errors.push({
      providerId: provider.id,
      error: `${provider.name} asked for a verification code and none was accepted within ${Math.round(
        run.waitForCodeMs / 60000
      )} minutes.`,
      verificationRequired: true,
    });
    return { status: 'error' };
  }

  if (run.verificationMode === 'defer') return { status: 'pending', step };

  run.manifest.errors.push({
    providerId: provider.id,
    error: verificationRequiredMessage(provider),
    verificationRequired: true,
  });
  return { status: 'error' };
}

// Hosts whose cookies belong to this provider's session (sign-in hosts + billing host).
function providerSignInDomains(provider, creds, billingUrl = provider.billingUrl) {
  const domains = new Set(creds?.allowedLoginDomains || buildAllowedLoginDomains({ provider }));
  try {
    domains.add(new URL(billingUrl).hostname.toLowerCase());
  } catch {}
  return [...domains];
}

function rememberSessionOwner(provider, owner, run, deps) {
  run.state = writeLocalState(
    {
      sessionOwners: {
        [provider.id]: {
          itemId: owner.itemId,
          username: (owner.username || '').toLowerCase(),
          profileId: run.activeProfile?.id || null,
          updatedAt: Date.now(),
        },
      },
    },
    { merge: true },
    deps
  );
}

/**
 * Navigates to the provider, signs in with password-manager credentials when needed and waits for
 * the billing page. Returns { status: 'ready' | 'skipped' | 'error' | 'pending', ... }.
 */
async function signInToProvider(page, context, provider, run, deps) {
  const { manifest } = run;
  const provConfig = {
    ...(run.state.providerConfigs?.[provider.id] || {}),
    ...(run.activeProfile?.configs?.[provider.id] || {}),
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
    return { status: 'skipped' };
  }

  const billingUrl = resolveBillingUrl(provider, provConfig);
  const pendingDomains = run.pendingDomains();
  if (pendingDomains.length && domainsOverlap(providerSignInDomains(provider, null, billingUrl), pendingDomains)) {
    // Signing in here would replace the session of a page still waiting for its code.
    manifest.skippedProviders.push({
      providerId: provider.id,
      reason: 'Shares its sign-in session with a provider waiting for a verification code; submit or cancel that code, then run again.',
    });
    return { status: 'skipped' };
  }
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
        profileName: run.activeProfile?.name || run.profileName || '',
        providerConfig: provConfig,
      },
      deps
    );
  } catch {}

  // Everything needed to continue after a verification code. Never the password.
  const signIn = (loginStartUrl, requestedAt) => ({
    provider,
    provConfig,
    billingUrl,
    loginStartUrl,
    requestedAt,
    hasOtpCredential: Boolean(creds?.otp),
    // Same hosts the password may be typed on (vault item URLs, billingUrl host, auth.loginDomains).
    allowedLoginDomains: creds?.allowedLoginDomains || buildAllowedLoginDomains({ provider }),
    owner: { itemId: creds?.itemId || null, username: creds?.username || '' },
  });

  // Auto-login, then deal with a verification-code step before leaving the sign-in page.
  const loginAndVerify = async () => {
    const loginStartUrl = page.url();
    const requestedAt = new Date().toISOString();
    await injectEngineIntoFrame(page.mainFrame());
    const loginRes = await guardedAutoLogin(page.mainFrame(), creds, provider.auth || {});
    if (loginRes?.blocked) {
      manifest.errors.push({ providerId: provider.id, error: describeLoginBlock({ ...loginRes, providerName: provider.name }) });
      return { status: 'error' };
    }
    if (!loginRes?.attempted) return { status: 'none', attempted: false };
    await page.waitForTimeout(4000);
    const ctx = signIn(loginStartUrl, requestedAt);
    const verdict = await handleVerificationStep(page, provider, ctx, run, deps);
    if (verdict.status === 'pending') return { status: 'pending', signIn: ctx, step: verdict.step };
    if (verdict.status === 'error') return { status: 'error' };
    return { status: 'none', attempted: true };
  };

  if (!readyCheck.success && creds) {
    const login = await loginAndVerify();
    if (login.status !== 'none') return login;
    if (login.attempted) readyCheck = await reachBillingAfterLogin(page, provider, billingUrl);
  }

  // If ready, verify identity matches expected 1Password credentials
  if (readyCheck.success && creds) {
    const previousOwner = run.state.sessionOwners?.[provider.id];
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
      // Only this provider's cookies, and never those of a page waiting for a code.
      await clearProviderCookies(context, providerSignInDomains(provider, creds), run.pendingDomains());
      if (provider.auth?.logoutUrl) {
        try {
          await page.goto(provider.auth.logoutUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch {}
      }
      try {
        await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch {}
      const login = await loginAndVerify();
      if (login.status !== 'none') return login;
      try {
        await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (billingUrl.includes('#')) await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch {}
      readyCheck = await waitForSelectorInFrame(page, provider, provider.readySelector, 12);
    }

    if (readyCheck.success) rememberSessionOwner(provider, creds, run, deps);
  }

  if (!readyCheck.success) {
    manifest.errors.push({
      providerId: provider.id,
      error: 'Billing page readySelector not reached (check login or 2FA challenge). Run with --headed to inspect.',
    });
    return { status: 'error' };
  }

  return { status: 'ready', readyCheck, provConfig };
}

/** On the billing page: learn config from the URL, run preSteps, extract rows and download. */
async function extractProviderInvoices(page, provider, { readyCheck, provConfig }, run, deps) {
  const { manifest } = run;

  // Auto-learn URL parameters (e.g. Stripe acct_... from redirected URL) and persist back to state!
  const learned = extractConfigFromUrls([page.url()], provider);
  for (const [k, v] of Object.entries(learned)) {
    if (!provConfig[k] && v) {
      setProfileOrProviderConfig(
        {
          profileName: run.activeProfile?.name || run.profileName,
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
  const previousDownloads = run.skipDedup
    ? []
    : (run.state.history || [])
        .filter(h => String(h).startsWith(`${provider.id}::`))
        .map(h => String(h).slice(`${provider.id}::`.length));

  const extraction = await targetFrame.evaluate(
    ([prov, cfg]) => window.__invoiceEngine.extractRows(prov, cfg),
    [
      provider,
      {
        maxInvoices: run.maxInvoices,
        sinceDate: run.sinceDate,
        previousDownloads,
        seen: [],
      },
    ]
  );

  const invoices = extraction?.invoices || [];
  const newHistoryKeys = [];

  for (const inv of invoices) {
    const filename = (inv.filename || `${provider.id}_${inv.date || 'invoice'}.pdf`).replace(/[/\\?%*:|"<>]/g, '_');
    const destPath = join(run.outDir, filename);

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
    run.state = writeLocalState({ history: newHistoryKeys }, { merge: true }, deps);
  }
}

function newManifest({ profile, outDir, sinceDate }) {
  return {
    profile,
    outDir,
    sinceDate,
    startedAt: new Date().toISOString(),
    downloadedFiles: [],
    learnedConfigs: {},
    skippedProviders: [],
    errors: [],
  };
}

/**
 * Options beyond the basics:
 * - verificationMode: 'fail' (default) records a clear error when a provider asks for a one-time
 *   code; 'wait' (CLI --wait-for-code) waits up to `waitForCodeMs`; 'defer' (MCP server) hands the
 *   open page to `onVerificationPending(pending)` and continues with the other providers.
 * - contextProvider: { acquire(launch), release() } to share one browser between runs and pages
 *   kept open for a code (required by 'defer').
 */
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
    verificationMode = 'fail',
    waitForCodeMs = CODE_STEP_TTL_MS,
    onVerificationPending = null,
    pendingDomains = () => [],
    onEvent = undefined,
    contextProvider = null,
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
  const launch = () =>
    chromium.launchPersistentContext(userDataDir, {
      headless: !headed,
      acceptDownloads: true,
      viewport: { width: 1366, height: 900 },
    });
  const context = contextProvider ? await contextProvider.acquire(launch, { headed }) : await launch();
  const browserVisible = contextProvider ? Boolean(contextProvider.headed ?? headed) : headed;

  const deferring = verificationMode === 'defer' && Boolean(contextProvider && onVerificationPending);
  const manifest = newManifest({ profile: activeProfile?.name || null, outDir, sinceDate });
  if (deferring) manifest.pendingVerification = [];

  const run = {
    manifest,
    state,
    activeProfile,
    profileName,
    sinceDate,
    maxInvoices,
    outDir,
    skipDedup,
    verificationMode: deferring ? 'defer' : verificationMode === 'wait' ? 'wait' : 'fail',
    waitForCodeMs,
    onEvent,
    pendingDomains,
  };

  // A shared browser may already hold pages waiting for a code: always work in a fresh tab then.
  let page = contextProvider ? await context.newPage() : context.pages()[0] || (await context.newPage());
  try {
    for (const provider of targetProviders) {
      const outcome = await signInToProvider(page, context, provider, run, deps);
      if (outcome.status === 'pending') {
        const pending = {
          ...outcome.signIn,
          page,
          providerId: provider.id,
          providerName: provider.name,
          pageHost: new URL(page.url()).hostname,
          hint: outcome.step.hint || '',
          headed: browserVisible,
          runOptions: { profileName, activeProfile, sinceDate, maxInvoices, outDir, skipDedup },
          deps,
        };
        manifest.pendingVerification.push(await onVerificationPending(pending));
        page = await context.newPage();
        continue;
      }
      if (outcome.status !== 'ready') continue;
      await extractProviderInvoices(page, provider, outcome, run, deps);
    }
  } finally {
    if (contextProvider) {
      await page.close().catch(() => {});
      await contextProvider.release();
    } else {
      await context.close();
    }
  }

  manifest.completedAt = new Date().toISOString();
  return manifest;
}

/**
 * Continues a provider left on its verification-code step (MCP server). With `code`, types it
 * and submits; without, only checks whether the user finished the step in the browser window
 * (waiting up to `waitMs`). Returns null while still waiting, a run manifest once signed in, and
 * throws VerificationCodeError when the provider rejects the code.
 */
export async function resumeAfterVerification(pending, { code, waitMs = 0 } = {}) {
  const { page, provider, billingUrl } = pending;
  const deps = pending.deps || {};
  const ctx = {
    billingUrl,
    loginStartUrl: pending.loginStartUrl,
    hasOtpCredential: pending.hasOtpCredential,
  };

  if (code != null) {
    await typeVerificationCode(page, provider, code, {
      allowedLoginDomains: pending.allowedLoginDomains || buildAllowedLoginDomains({ provider }),
      inject: injectEngineIntoFrame,
    });
    const accepted = await waitForCodeStepExit(page, provider, ctx, {
      inject: injectEngineIntoFrame,
      timeoutMs: pending.acceptTimeoutMs ?? 20000,
    });
    if (!accepted) {
      throw new VerificationCodeError(
        `${provider.name} did not accept the code (still on the verification step). Check for a newer email and try again.`,
        { retryable: true }
      );
    }
  } else {
    const left = await waitForCodeStepExit(page, provider, ctx, { inject: injectEngineIntoFrame, timeoutMs: waitMs });
    if (!left) return null;
  }

  const opts = pending.runOptions || {};
  const run = {
    manifest: newManifest({ profile: opts.activeProfile?.name || null, outDir: opts.outDir, sinceDate: opts.sinceDate || null }),
    state: readLocalState(deps),
    activeProfile: opts.activeProfile || null,
    profileName: opts.profileName || '',
    sinceDate: opts.sinceDate || null,
    maxInvoices: opts.maxInvoices || 999,
    outDir: opts.outDir,
    skipDedup: Boolean(opts.skipDedup),
  };

  const readyCheck = await reachBillingAfterLogin(page, provider, billingUrl);
  if (!readyCheck.success) {
    run.manifest.errors.push({
      providerId: provider.id,
      error: 'Signed in after the verification code, but the billing page readySelector was not reached.',
    });
  } else {
    if (pending.owner?.itemId) rememberSessionOwner(provider, pending.owner, run, deps);
    await extractProviderInvoices(page, provider, { readyCheck, provConfig: pending.provConfig || {} }, run, deps);
  }
  run.manifest.completedAt = new Date().toISOString();
  return run.manifest;
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
    let loginBlocked = null;

    if (loginDet?.hasLoginForm || itemOverride || profileName) {
      let creds = null;
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        creds = await handleHostRequest(
          {
            action: 'resolveProvider',
            // No billingUrl on this ad-hoc provider: only the vault item's own URLs may
            // receive its login, never the address passed on the command line.
            provider: {
              id: hostname.split('.')[0],
              name: hostname.split('.')[0],
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
        const loginRes = await guardedAutoLogin(page.mainFrame(), creds, {}).catch(() => null);
        if (loginRes?.blocked) {
          loginBlocked = describeLoginBlock({ ...loginRes, providerName: creds.title || new URL(url).hostname });
        }

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
      loginBlocked,
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

// `--wait-for-code` → 10 minutes; `--wait-for-code=5` → 5 minutes; absent → fail fast.
export function parseWaitForCode(flag) {
  if (flag === undefined || flag === false) return { verificationMode: 'fail' };
  const minutes = flag === true ? CODE_STEP_TTL_MS / 60000 : Number(flag);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) {
    throw new Error('--wait-for-code expects a number of minutes between 1 and 60 (default 10).');
  }
  return { verificationMode: 'wait', waitForCodeMs: Math.round(minutes * 60000) };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
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
      ...parseWaitForCode(flags['wait-for-code']),
    });
    console.log(JSON.stringify({ ok: true, ...manifest }, null, 2));
    return;
  }

  if (command === 'submit-code') {
    // Prefer stdin (`echo 123456 | invoice-extractor submit-code --id ...`): argv is visible to
    // other local processes and lands in shell history.
    const code = typeof flags.code === 'string' ? flags.code : await readStdin();
    try {
      const res = await handOverCode(dirname(resolveStatePath()), String(flags.id || ''), code);
      console.log(JSON.stringify({ ok: Boolean(res.accepted), ...res }, null, 2));
      if (!res.accepted) process.exitCode = 1;
    } catch (err) {
      const message = err instanceof VerificationCodeError ? err.message : redactCode(err.message, code);
      console.error(JSON.stringify({ ok: false, error: message, retryable: Boolean(err.retryable) }, null, 2));
      process.exitCode = 1;
    }
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
