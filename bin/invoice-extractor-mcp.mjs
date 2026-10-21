#!/usr/bin/env node
/**
 * Model Context Protocol (MCP) stdio server for Invoice Extractor.
 *
 * Zero-dependency JSON-RPC 2.0 server over stdin/stdout so non-technical users
 * on Claude Desktop (macOS, Windows, Linux) or any MCP client can manage
 * 1Password vaults, onboard SaaS providers, and download invoices via natural language.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  loadAllProviders,
  onboardProvider,
  resumeAfterVerification,
  runAgentExtraction,
  runDoctor,
  runSetup,
  setProfileOrProviderConfig,
  syncProfilesFrom1PasswordToState,
} from './invoice-extractor.mjs';
import { handleHostRequest, readLocalState } from '../scripts/onepassword-host.mjs';
import {
  buildNextStep,
  createVerificationRegistry,
  redactCode,
  VerificationCodeError,
} from '../scripts/verification-code.mjs';

const SERVER_INFO = {
  name: 'invoice-extractor',
  version: '1.0.0',
};

// Provider pages waiting for a one-time verification code (kept open up to 10 minutes).
const verifications = createVerificationRegistry({ resume: resumeAfterVerification });

const TOOLS = [
  {
    name: 'invoice_extractor_status',
    description:
      'Check 1Password vault connectivity, installed dependencies, and synced client profiles.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'invoice_extractor_sync_profiles',
    description:
      'Scan 1Password vaults (AI, AI bots, Personal, Shared, Employee, Finance, etc.), group logins by client tag, and save profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Optional vault name or alias to prioritize (e.g. AI, Personal, Shared, Facturas).',
        },
      },
    },
  },
  {
    name: 'invoice_extractor_run',
    description:
      'Download SaaS invoices for a client profile or specific providers using 1Password credentials. Saves PDFs to Desktop/Facturas by default. ' +
      'Passwords never reach you. If a provider emails/texts a one-time verification code after the password, the run does not fail: ' +
      'that provider is listed in `pendingVerification` (its page stays open for 10 minutes) and `nextStep` explains what to do. ' +
      'Rule: if you can read the user\'s email, read the provider\'s code there and call invoice_extractor_submit_code; if not, ask the user.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'Client profile name (e.g. Acme, Globex, Personal).',
        },
        providers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of provider IDs (e.g. ["holded", "stripe", "openai"]).',
        },
        sinceDate: {
          type: 'string',
          description: 'Optional start date in YYYY-MM-DD format.',
        },
        maxInvoices: {
          type: 'number',
          description: 'Maximum number of invoices per provider.',
        },
        outDir: {
          type: 'string',
          description: 'Output directory for downloaded PDFs (defaults to ~/Desktop/Facturas).',
        },
        headed: {
          type: 'boolean',
          description:
            'Open visible browser window (lets the user type an SMS/email verification code or solve a captcha themselves).',
        },
      },
    },
  },
  {
    name: 'invoice_extractor_submit_code',
    description:
      'Continue a provider that is waiting for a one-time verification code (listed in pendingVerification by invoice_extractor_run). ' +
      'Get the code from the user\'s email if you can read it (newest message from that provider after requestedAt); otherwise ask the user for it. ' +
      'Types the code on the provider page (only if the page still belongs to that provider), signs in and downloads that provider\'s invoices, returning them like a run. ' +
      'Omit code if the user typed it in the open browser window themselves. A rejected code returns an error and can be retried until expiresAt.',
    inputSchema: {
      type: 'object',
      properties: {
        verificationId: {
          type: 'string',
          description: 'verificationId from pendingVerification.',
        },
        code: {
          type: 'string',
          description: 'The one-time code (4-10 letters or digits; spaces and dashes are ignored). Omit if the user typed it in the browser.',
        },
      },
      required: ['verificationId'],
    },
  },
  {
    name: 'invoice_extractor_cancel_verification',
    description:
      'Give up on a provider waiting for a one-time verification code and close its browser page (omit verificationId to cancel all). ' +
      'Needed before running another client profile while a code is pending: runs share one browser session, so a run for a different profile is refused until the pending code is submitted or cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        verificationId: {
          type: 'string',
          description: 'verificationId from pendingVerification; omit to cancel every pending verification.',
        },
      },
    },
  },
  {
    name: 'invoice_extractor_onboard_provider',
    description:
      'Verify an existing SaaS provider with the user 1Password credentials, auto-repair it if it fails, or inspect and create a new provider if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider name or ID (e.g. holded, stripe, notion, figma).',
        },
        url: {
          type: 'string',
          description: 'Optional billing URL if onboarding a brand-new provider.',
        },
        profile: {
          type: 'string',
          description: 'Optional client profile name.',
        },
        headed: {
          type: 'boolean',
          description: 'Whether to show the browser window during onboarding.',
        },
      },
      required: ['provider'],
    },
  },
  {
    name: 'invoice_extractor_save_credential',
    description:
      'Save or update a provider login URL, username, and client tag in 1Password or Bitwarden and sync profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        manager: {
          type: 'string',
          description: 'Optional password manager ("1password" or "bitwarden").',
        },
        vault: {
          type: 'string',
          description: 'Target 1Password vault name/alias (e.g. AI, AI bots, Personal, Shared, Facturas) or "bitwarden".',
        },
        title: {
          type: 'string',
          description: 'Item title in 1Password/Bitwarden (e.g. "Stripe Acme").',
        },
        url: {
          type: 'string',
          description: 'Billing or login URL.',
        },
        username: {
          type: 'string',
          description: 'Login email or username.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Client tags (e.g. ["Acme"]).',
        },
      },
      required: ['title', 'url'],
    },
  },
];

async function executeTool(name, args = {}) {
  const providers = loadAllProviders();

  if (name === 'invoice_extractor_status') {
    const doctor = await runDoctor({ fix: false });
    const localState = readLocalState();
    let opStatus = null;
    try {
      opStatus = await handleHostRequest({ action: 'status' });
    } catch (e) {
      opStatus = { available: false, error: e.message };
    }
    return {
      doctor,
      onepassword: opStatus,
      profiles: localState.profiles,
      historyCount: localState.history.length,
    };
  }

  if (name === 'invoice_extractor_sync_profiles') {
    return syncProfilesFrom1PasswordToState(providers, {
      vaultHint: args.vault || '',
    });
  }

  if (name === 'invoice_extractor_run') {
    const defaultOut = join(homedir(), 'Desktop', 'Facturas');
    const profileName = String(args.profile || '').trim();
    const manifest = await verifications.runExclusive(profileName, () => runAgentExtraction({
      profileName,
      providerIds: Array.isArray(args.providers) ? args.providers : [],
      sinceDate: args.sinceDate || null,
      maxInvoices: args.maxInvoices || 999,
      outDir: args.outDir ? resolve(args.outDir) : defaultOut,
      headed: Boolean(args.headed),
      verificationMode: 'defer',
      contextProvider: verifications.contextProvider,
      onVerificationPending: pending =>
        verifications.add({ ...pending, profileName, profileKey: profileName.toLowerCase() }),
    }));
    const nextStep = buildNextStep(manifest.pendingVerification);
    return nextStep ? { ...manifest, nextStep } : manifest;
  }

  if (name === 'invoice_extractor_cancel_verification') {
    const cancelled = await verifications.cancel(args.verificationId ? String(args.verificationId) : null);
    return { cancelled, pendingVerification: verifications.list() };
  }

  if (name === 'invoice_extractor_submit_code') {
    const hasCode = typeof args.code === 'string' && args.code.trim() !== '';
    try {
      const outcome = await verifications.submit(String(args.verificationId || ''), hasCode ? args.code : null, {
        waitMs: hasCode ? 0 : 60000,
      });
      if (outcome.status === 'waiting') {
        return {
          ...outcome,
          nextStep:
            'The provider page is still on the verification step. Get the code from the user\'s email or from the user and call invoice_extractor_submit_code again with it.',
        };
      }
      return { completedBy: outcome.completedBy, ...outcome.result };
    } catch (err) {
      if (err instanceof VerificationCodeError) {
        throw new Error(`${err.message}${err.retryable ? ' (retryable)' : ''}`);
      }
      throw new Error(redactCode(`Could not continue after the verification code: ${err.message}`, args.code));
    }
  }

  if (name === 'invoice_extractor_onboard_provider') {
    // Onboarding opens its own browser on the same persistent profile: never while runs use it.
    return verifications.runExclusive(String(args.profile || '').trim(), () => {
      if (verifications.list().length > 0) {
        throw new Error(
          'A provider page is waiting for a verification code. Submit it with invoice_extractor_submit_code or cancel it with invoice_extractor_cancel_verification before onboarding.'
        );
      }
      return onboardProvider({
        target: args.provider || '',
        url: args.url || '',
        profileName: args.profile || '',
        headed: Boolean(args.headed),
      });
    });
  }

  if (name === 'invoice_extractor_save_credential') {
    const saved = await handleHostRequest({
      action: 'upsertOpItem',
      manager: args.manager || '',
      vaultHint: args.vault || 'AI',
      title: args.title,
      url: args.url || '',
      username: args.username || '',
      tags: args.tags || [],
    });
    const synced = await syncProfilesFrom1PasswordToState(providers);
    return { item: saved, profiles: synced.profiles };
  }

  if (name === 'invoice_extractor_setup') {
    return runSetup(args);
  }

  if (name === 'invoice_extractor_config_set') {
    return setProfileOrProviderConfig(args);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function sendJson(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('close', () => {
  verifications.closeAll().finally(() => process.exit(0));
});

rl.on('line', async line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === 'initialize') {
    sendJson({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    sendJson({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (method === 'tools/call') {
    try {
      const data = await executeTool(params?.name, params?.arguments || {});
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        },
      });
    } catch (error) {
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message }) }],
        },
      });
    }
    return;
  }

  if (id !== undefined) {
    sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
