/**
 * Transient-500 watchdog tests.
 *
 * Covers:
 *   - findLatestErrorMarker: picks the LATEST 500, ignores non-500 API errors
 *     and non-error records, tolerates blank/garbage lines, null when none.
 *   - sweep fires once per 500 (notify + injected continue nudge) and dedups on
 *     subsequent sweeps — the hard "only one alert per error" requirement.
 *   - gating: skips daemon-spawned, dead cc_pid, missing session_id, and
 *     transcripts with no 500.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentRow, DurableRegistry } from '../src/registry';
import { createDurableRegistry } from '../src/registry';
import {
  CONTINUE_NUDGE_TEXT,
  createErrorWatchdog,
  findLatestErrorMarker,
} from '../src/slack/error-watchdog';
import { makePoster } from './fakes/slack';

// ---- Fixtures ----

const CHANNEL = 'C_WD';
const MACHINE = 'test-machine';
const CWD = '/Users/test/Documents/repo';
const PROJECTS = '/test-projects';
const NOW = 1_700_000_000_000;

const FIVE_HUNDRED = (requestId: string): string =>
  JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    apiErrorStatus: 500,
    error: 'server_error',
    requestId,
    message: { model: '<synthetic>' },
  });

const NORMAL_TURN = JSON.stringify({
  type: 'assistant',
  requestId: 'req_normal',
  message: { model: 'claude-opus-4-7' },
});

/** Path the watchdog will compute for a given session (mirrors transcriptPathFor). */
function transcriptPath(cwd: string, sessionId: string): string {
  return join(PROJECTS, cwd.replaceAll('/', '-'), `${sessionId}.jsonl`);
}

describe('findLatestErrorMarker', () => {
  it('returns the most recent 500 requestId when several are present', () => {
    const transcript = [
      FIVE_HUNDRED('req_OLD'),
      NORMAL_TURN,
      FIVE_HUNDRED('req_NEW'),
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
    ].join('\n');
    expect(findLatestErrorMarker(transcript)?.requestId).toBe('req_NEW');
  });

  it('returns null when there is no 500 marker', () => {
    expect(findLatestErrorMarker(`${NORMAL_TURN}\n${NORMAL_TURN}`)).toBeNull();
  });

  it('ignores API errors that are not status 500 (e.g. 429)', () => {
    const transcript = JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      requestId: 'req_429',
    });
    expect(findLatestErrorMarker(transcript)).toBeNull();
  });

  it('ignores 500-ish records that are not flagged isApiErrorMessage', () => {
    const transcript = JSON.stringify({
      type: 'assistant',
      apiErrorStatus: 500,
      requestId: 'req_no_flag',
    });
    expect(findLatestErrorMarker(transcript)).toBeNull();
  });

  it('tolerates blank lines and a partially-written trailing line', () => {
    const transcript = `\n${FIVE_HUNDRED('req_X')}\n\n{not valid json`;
    expect(findLatestErrorMarker(transcript)?.requestId).toBe('req_X');
  });
});

describe('error watchdog sweep', () => {
  let tmpDir: string;
  let registry: DurableRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wd-test-'));
    registry = createDurableRegistry({ dbPath: join(tmpDir, 'registry.db') });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function attach(overrides?: {
    threadTs?: string;
    sessionId?: string | null;
    ownerMode?: 'terminal-attached' | 'daemon-spawned';
    ccPid?: number | null;
  }): AttachmentRow {
    return registry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: overrides?.threadTs ?? '100.001',
      sessionId:
        overrides?.sessionId === undefined ? 'sess-aaa' : overrides.sessionId,
      cwd: CWD,
      machineId: MACHINE,
      ownerMode: overrides?.ownerMode ?? 'terminal-attached',
      ccPid: overrides?.ccPid === undefined ? 4242 : overrides.ccPid,
    });
  }

  function watchdog(
    transcripts: Record<string, string>,
    opts?: { pidAlive?: boolean },
  ) {
    return createErrorWatchdog({
      registry,
      poster: poster.poster,
      projectsDir: PROJECTS,
      readTranscript: (p) => transcripts[p] ?? null,
      isPidAlive: () => opts?.pidAlive ?? true,
    });
  }

  let poster: ReturnType<typeof makePoster>;
  beforeEach(() => {
    poster = makePoster();
  });

  function leasedTexts(attachmentId: string): string[] {
    return registry
      .leaseNextMessages({ attachmentId, ownerToken: 'test', limit: 50 })
      .map((m) => m.text);
  }

  it('fires once on a 500 — notify + injected nudge — then dedups', async () => {
    const att = attach();
    const transcripts = {
      [transcriptPath(CWD, 'sess-aaa')]:
        `${NORMAL_TURN}\n${FIVE_HUNDRED('req_BRICK')}\n`,
    };
    const wd = watchdog(transcripts);

    // First sweep: fires.
    expect(await wd.sweepOnce(NOW)).toBe(1);
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0].channel).toBe(CHANNEL);
    expect(poster.posts[0].threadTs).toBe(att.thread_ts);
    expect(poster.posts[0].text).toContain('req_BRICK');
    // Nudge was injected into the attachment's inbox.
    expect(leasedTexts(att.id)).toContain(CONTINUE_NUDGE_TEXT);

    // Second sweep on the SAME 500: deduped — no new notify, no new nudge.
    expect(await wd.sweepOnce(NOW + 60_000)).toBe(0);
    expect(poster.posts).toHaveLength(1);
    expect(leasedTexts(att.id)).toHaveLength(0);
  });

  it('fires again when a NEW 500 (different requestId) appears later', async () => {
    attach(); // discovered via listActiveAttachments; return value unused here
    const path = transcriptPath(CWD, 'sess-aaa');
    const transcripts = { [path]: `${FIVE_HUNDRED('req_ONE')}\n` };
    const wd = watchdog(transcripts);

    expect(await wd.sweepOnce(NOW)).toBe(1);
    // Session recovers, works, then hits a second, distinct 500.
    transcripts[path] =
      `${FIVE_HUNDRED('req_ONE')}\n${NORMAL_TURN}\n${FIVE_HUNDRED('req_TWO')}\n`;
    expect(await wd.sweepOnce(NOW + 60_000)).toBe(1);
    expect(poster.posts).toHaveLength(2);
    expect(poster.posts[1].text).toContain('req_TWO');
  });

  it('does not fire when the transcript has no 500', async () => {
    const att = attach();
    const wd = watchdog({
      [transcriptPath(CWD, 'sess-aaa')]: `${NORMAL_TURN}\n${NORMAL_TURN}`,
    });
    expect(await wd.sweepOnce(NOW)).toBe(0);
    expect(poster.posts).toHaveLength(0);
    expect(leasedTexts(att.id)).toHaveLength(0);
  });

  it('skips daemon-spawned attachments', async () => {
    attach({ ownerMode: 'daemon-spawned' });
    const wd = watchdog({
      [transcriptPath(CWD, 'sess-aaa')]: FIVE_HUNDRED('req_BRICK'),
    });
    expect(await wd.sweepOnce(NOW)).toBe(0);
    expect(poster.posts).toHaveLength(0);
  });

  it('skips sessions whose cc_pid is dead', async () => {
    attach({ ccPid: 999999 });
    const wd = watchdog(
      { [transcriptPath(CWD, 'sess-aaa')]: FIVE_HUNDRED('req_BRICK') },
      { pidAlive: false },
    );
    expect(await wd.sweepOnce(NOW)).toBe(0);
    expect(poster.posts).toHaveLength(0);
  });

  it('skips attachments with no session_id (cannot locate a transcript)', async () => {
    attach({ sessionId: null });
    // Even if some transcript existed, there is no session_id to resolve it.
    const wd = watchdog({
      [transcriptPath(CWD, 'sess-aaa')]: FIVE_HUNDRED('req_BRICK'),
    });
    expect(await wd.sweepOnce(NOW)).toBe(0);
    expect(poster.posts).toHaveLength(0);
  });
});

