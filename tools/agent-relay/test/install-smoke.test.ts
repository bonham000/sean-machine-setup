import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPlist, LABEL, renderPlist } from '../scripts/install';

describe('agent relay machine installer', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agent-relay-install-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test('renders the preserved label and staged bundle path', () => {
    const rendered = renderPlist(home, '/test/bun');
    expect(rendered).toContain(LABEL);
    expect(rendered).toContain(`${home}/.claude/agent-relay/dist/index.js`);
    expect(rendered).toContain('/test/bun');
  });

  test('installs plist and creates the log directory without launchctl', () => {
    const path = installPlist(home, '/test/bun');
    expect(existsSync(path)).toBeTrue();
    expect(readFileSync(path, 'utf8')).toContain('relay.stdout.log');
    expect(existsSync(join(home, '.claude', 'agent-relay', 'logs'))).toBeTrue();
  });
});
