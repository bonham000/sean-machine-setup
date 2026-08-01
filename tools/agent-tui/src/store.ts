import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureDirectories, sessionRecordPath, sessionsDirectory } from "./paths.ts";
import type { SessionRecord } from "./types.ts";

function hydrateSession(record: SessionRecord): SessionRecord {
  return {
    ...record,
    harness: record.harness || basename(record.command),
    repoRoot: record.repoRoot || record.cwd,
    repoName: record.repoName || basename(record.repoRoot || record.cwd) || "root",
    firstPrompt: record.firstPrompt || null,
  };
}

export async function writeSession(record: SessionRecord): Promise<void> {
  await ensureDirectories();
  const destination = sessionRecordPath(record.id);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export async function readSession(id: string): Promise<SessionRecord> {
  const body = await readFile(sessionRecordPath(id), "utf8");
  return hydrateSession(JSON.parse(body) as SessionRecord);
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureDirectories();
  const names = (await readdir(sessionsDirectory())).filter((name) => /^[a-f0-9]{12}\.json$/.test(name));
  const records: SessionRecord[] = [];
  for (const name of names) {
    try {
      const body = await readFile(join(sessionsDirectory(), name), "utf8");
      records.push(hydrateSession(JSON.parse(body) as SessionRecord));
    } catch {
      // A damaged or concurrently replaced record should not hide healthy sessions.
    }
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function resolveSession(query: string): Promise<SessionRecord> {
  const sessions = await listSessions();
  const exact = sessions.find((session) => session.id === query);
  if (exact) return exact;

  const matches = sessions.filter(
    (session) => session.id.startsWith(query) || session.name === query || basename(session.command) === query,
  );
  if (matches.length === 0) throw new Error(`No agent-tui session matches ${JSON.stringify(query)}`);
  const active = matches.filter((session) => session.status === "running" || session.status === "starting");
  const candidates = active.length > 0 ? active : matches;
  if (candidates.length > 1) {
    throw new Error(`Session ${JSON.stringify(query)} is ambiguous: ${candidates.map((item) => item.id).join(", ")}`);
  }
  return candidates[0]!;
}
