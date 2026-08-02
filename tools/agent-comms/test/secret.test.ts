import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSecret, getSecretPath } from '../src/secret';

describe('getSecretPath', () => {
  it('returns path under provided home', () => {
    const p = getSecretPath('/fake/home');
    expect(p).toBe('/fake/home/.claude/agent-comms/secret');
  });

  it('falls back to real homedir when no arg', () => {
    const p = getSecretPath();
    expect(p).toContain('.claude/agent-comms/secret');
  });
});

describe('ensureSecret', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agent-comms-secret-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates a secret file with 0600 permissions on first call', () => {
    const secret = ensureSecret({ home: tmpHome });
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(0);

    const secretPath = getSecretPath(tmpHome);
    const mode = statSync(secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns the same value on subsequent calls (idempotent)', () => {
    const first = ensureSecret({ home: tmpHome });
    const second = ensureSecret({ home: tmpHome });
    expect(first).toBe(second);
  });

  it('creates parent directories as needed', () => {
    const nested = join(tmpHome, 'deep', 'nested');
    const secret = ensureSecret({ home: nested });
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(0);
  });
});

