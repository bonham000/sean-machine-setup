import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LABEL } from './install';

const path = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = `gui/${process.getuid?.() ?? 501}`;
await Bun.spawn(['launchctl', 'bootout', domain, path], {
  stdout: 'ignore',
  stderr: 'ignore',
}).exited;
if (existsSync(path)) unlinkSync(path);
console.log(`Uninstalled ${LABEL}; staged bundles and logs were preserved.`);
