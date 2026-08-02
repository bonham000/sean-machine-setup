/**
 * Smoke tests for scripts/install.ts using a temp home dir.
 *
 * Exercises: plist rendering, slash command install, CLI symlink. Does NOT
 * run buildDist (too slow) or loadDaemon (requires launchctl). Tests call
 * individual exported step functions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installCLIBinary,
  installSlashCommand,
  PLIST_LABEL,
  renderPlist,
  resolveEnvSource,
  stageEnv,
} from '../scripts/install';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'install-smoke-'));
}

describe('install smoke (temp home, no-load)', () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('renderPlist', () => {
    it('writes plist containing com.priori.agent-comms label', () => {
      const plistPath = join(
        home,
        'Library',
        'LaunchAgents',
        `${PLIST_LABEL}.plist`,
      );
      const logDir = join(home, '.claude', 'agent-comms', 'logs');
      renderPlist(home, plistPath, logDir);
      expect(existsSync(plistPath)).toBe(true);
      const content = readFileSync(plistPath, 'utf8');
      expect(content).toContain(PLIST_LABEL);
      expect(content).toContain(home);
    });

    it('creates log directory', () => {
      const plistPath = join(
        home,
        'Library',
        'LaunchAgents',
        `${PLIST_LABEL}.plist`,
      );
      const logDir = join(home, '.claude', 'agent-comms', 'logs');
      renderPlist(home, plistPath, logDir);
      expect(existsSync(logDir)).toBe(true);
    });
  });

  describe('environment staging', () => {
    it('uses the core-repo environment without copying it into machine setup', () => {
      const source = join(home, 'Documents', 'core-repo', '.env');
      const botDir = join(home, '.claude', 'agent-comms');
      mkdirSync(join(home, 'Documents', 'core-repo'), { recursive: true });
      writeFileSync(source, 'SLACK_BOT_TOKEN_AGENT_COMMS=test\n');
      const previous = process.env.AGENT_COMMS_ENV_FILE;
      delete process.env.AGENT_COMMS_ENV_FILE;
      try {
        expect(resolveEnvSource(home)).toBe(source);
        stageEnv(botDir, home);
        expect(readFileSync(join(botDir, '.env'), 'utf8')).toContain(
          'SLACK_BOT_TOKEN_AGENT_COMMS=test',
        );
      } finally {
        if (previous !== undefined) process.env.AGENT_COMMS_ENV_FILE = previous;
      }
    });

    it('supports an explicit environment file override', () => {
      const source = join(home, 'custom.env');
      writeFileSync(source, 'CUSTOM=true\n');
      const previous = process.env.AGENT_COMMS_ENV_FILE;
      process.env.AGENT_COMMS_ENV_FILE = source;
      try {
        expect(resolveEnvSource(home)).toBe(source);
      } finally {
        if (previous === undefined) delete process.env.AGENT_COMMS_ENV_FILE;
        else process.env.AGENT_COMMS_ENV_FILE = previous;
      }
    });
  });

  describe('installSlashCommand', () => {
    it('installs slack-attach-session.md', () => {
      const commandsDir = join(home, '.claude', 'commands');
      installSlashCommand(commandsDir);
      const cmd = join(commandsDir, 'slack-attach-session.md');
      expect(existsSync(cmd)).toBe(true);
      const content = readFileSync(cmd, 'utf8');
      expect(content).toContain('attaches this Claude Code session');
    });

    it('does not install handoff.md', () => {
      const commandsDir = join(home, '.claude', 'commands');
      installSlashCommand(commandsDir);
      expect(existsSync(join(commandsDir, 'handoff.md'))).toBe(false);
    });

    it('is idempotent — re-running does not fail', () => {
      const commandsDir = join(home, '.claude', 'commands');
      installSlashCommand(commandsDir);
      // Second run should not throw
      expect(() => installSlashCommand(commandsDir)).not.toThrow();
    });
  });

  describe('installCLIBinary', () => {
    it('creates a symlink at <home>/.local/bin/agent-comms', () => {
      const binDir = join(home, '.local', 'bin');
      installCLIBinary(binDir);
      const symlinkPath = join(binDir, 'agent-comms');
      expect(existsSync(symlinkPath)).toBe(true);
      const stat = lstatSync(symlinkPath);
      expect(stat.isSymbolicLink()).toBe(true);
    });

    it('symlink target points to src/cli/index.ts', () => {
      const binDir = join(home, '.local', 'bin');
      installCLIBinary(binDir);
      const symlinkPath = join(binDir, 'agent-comms');
      // readlinkSync via Bun.readlink or lstat — use require
      const { readlinkSync } = require('node:fs') as typeof import('node:fs');
      const target = readlinkSync(symlinkPath);
      expect(target).toContain('src/cli/index.ts');
    });

    it('is idempotent — re-running replaces the symlink without error', () => {
      const binDir = join(home, '.local', 'bin');
      installCLIBinary(binDir);
      expect(() => installCLIBinary(binDir)).not.toThrow();
      const { readlinkSync } = require('node:fs') as typeof import('node:fs');
      const target = readlinkSync(join(binDir, 'agent-comms'));
      expect(target).toContain('src/cli/index.ts');
    });
  });
});
