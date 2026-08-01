#!/usr/bin/env bun

import { chmod, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");
const binDirectory = join(homedir(), ".local", "bin");
const destination = join(binDirectory, "agent-tui");

await mkdir(binDirectory, { recursive: true });
await chmod(source, 0o755);
try {
  const existing = await lstat(destination);
  if (!existing.isSymbolicLink()) {
    throw new Error(`Refusing to replace non-symlink ${destination}`);
  }
  await readlink(destination);
  await unlink(destination);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await symlink(source, destination);
process.stdout.write(`Installed ${destination} -> ${source}\n`);
