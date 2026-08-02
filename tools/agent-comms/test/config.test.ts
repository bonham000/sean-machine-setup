/**
 * Regression for codex finding: blank-string env vars must not survive as
 * `""` — they should fall back to the documented defaults. Bun loads
 * `KEY=` in .env as an empty string, not `undefined`, so the bare `??`
 * fallback that shipped initially would have spawned CC sessions with
 * cwd `""`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveMachineId } from '../src/config';

const REQUIRED_VARS = {
  SLACK_BOT_TOKEN_AGENT_COMMS: 'xoxb-test',
  SLACK_APP_TOKEN_AGENT_COMMS: 'xapp-test',
  SLACK_AGENT_COMMS_CHANNEL: 'C123',
  SLACK_AGENT_COMMS_ALLOWED_USERS: 'U1,U2',
};

const OPTIONAL_VARS = [
  'MACHINE_ID',
  'AGENT_COMMS_PORT',
  'AGENT_COMMS_DEFAULT_CWD',
] as const;

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const [k, v] of Object.entries(REQUIRED_VARS)) {
    snapshot[k] = process.env[k];
    process.env[k] = v;
  }
  for (const k of OPTIONAL_VARS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('loadConfig() optional-var empty-string handling', () => {
  test('blank AGENT_COMMS_DEFAULT_CWD falls back to documented default', () => {
    process.env.AGENT_COMMS_DEFAULT_CWD = '';
    const cfg = loadConfig();
    expect(cfg.defaultMentionCwd).toBe(
      join(homedir(), 'Documents', 'core-repo'),
    );
  });

  test('blank AGENT_COMMS_PORT falls back to 42100', () => {
    process.env.AGENT_COMMS_PORT = '';
    const cfg = loadConfig();
    expect(cfg.port).toBe(42100);
  });

  test('populated optional vars are still respected', () => {
    process.env.AGENT_COMMS_DEFAULT_CWD = '/custom/dir';
    process.env.AGENT_COMMS_PORT = '54321';
    process.env.MACHINE_ID = 'mac-mini';
    const cfg = loadConfig();
    expect(cfg.defaultMentionCwd).toBe('/custom/dir');
    expect(cfg.port).toBe(54321);
    expect(cfg.machineId).toBe('mac-mini');
  });
});

describe('resolveMachineId() fallback chain', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'machine-id-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('blank MACHINE_ID and no identity file → "unknown"', () => {
    process.env.MACHINE_ID = '';
    expect(resolveMachineId(tmpHome)).toBe('unknown');
  });

  test('blank MACHINE_ID with identity file → uses identity-file value', () => {
    process.env.MACHINE_ID = '';
    writeFileSync(
      join(tmpHome, '.AGENT_MACHINE_IDENTITY'),
      '# header comment\nMACHINE_ID=mac-mini\nMACHINE_LABEL="Mac Mini"\n',
    );
    expect(resolveMachineId(tmpHome)).toBe('mac-mini');
  });

  test('populated MACHINE_ID env wins over identity file', () => {
    process.env.MACHINE_ID = 'override-id';
    writeFileSync(
      join(tmpHome, '.AGENT_MACHINE_IDENTITY'),
      'MACHINE_ID=mac-mini\n',
    );
    expect(resolveMachineId(tmpHome)).toBe('override-id');
  });
});

