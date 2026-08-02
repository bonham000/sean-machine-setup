import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function getSecretPath(home?: string): string {
  return join(
    home ?? process.env.HOME ?? homedir(),
    '.claude',
    'agent-comms',
    'secret',
  );
}

export function ensureSecret(opts?: { home?: string }): string {
  const secretPath = getSecretPath(opts?.home);
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, 'utf8').trim();
  }
  mkdirSync(dirname(secretPath), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  return secret;
}

