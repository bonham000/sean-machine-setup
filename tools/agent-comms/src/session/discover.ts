/**
 * Find the most recently modified Claude Code session JSONL for a given cwd.
 *
 * CC stores sessions at ~/.claude/projects/{escaped-cwd}/{sessionId}.jsonl
 * where every '/' in the cwd is replaced with '-'.
 *
 * CLI: bun src/session/discover.ts /path/to/cwd
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionInfo {
  sessionId: string;
  jsonlPath: string;
  mtime: number;
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export function discoverCurrentSession(cwd: string): SessionInfo | null {
  const escaped = cwd.replaceAll('/', '-');
  const projectDir = join(PROJECTS_DIR, escaped);

  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return null;
  }

  let newest: SessionInfo | null = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(projectDir, name);
    const mtime = statSync(path).mtimeMs;
    if (!newest || mtime > newest.mtime) {
      const sessionId = name.replace(/\.jsonl$/, '');
      newest = { sessionId, jsonlPath: path, mtime };
    }
  }
  return newest;
}

if (import.meta.main) {
  const cwd = process.argv[2];
  if (!cwd) {
    console.error('Usage: bun src/session/discover.ts <cwd>');
    process.exit(1);
  }
  const session = discoverCurrentSession(cwd);
  if (!session) {
    console.error(`No session found for ${cwd}`);
    process.exit(1);
  }
  console.log(JSON.stringify(session, null, 2));
}

