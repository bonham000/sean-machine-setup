/**
 * Size-bounded rotation for the launchd-owned daemon logs.
 *
 * launchd opens StandardOutPath/StandardErrorPath itself, before any of this
 * code runs, and keeps that descriptor for the life of the process. That rules
 * out rename-based rotation: renaming the file leaves launchd writing to the
 * renamed inode, and the "fresh" log would stay empty forever.
 *
 * So rotation copies the content aside and then truncates the original **in
 * place**, preserving the inode launchd holds. launchd opens these files with
 * O_APPEND, so subsequent writes resume at offset 0 of the truncated file.
 *
 * One previous generation is kept (`<name>.1`). That is enough to investigate
 * the run that just filled the log without letting history grow without bound
 * again.
 */

import { copyFileSync, existsSync, statSync, truncateSync } from 'node:fs';

/** 8 MiB: large enough for a long healthy run, small enough to read. */
export const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;

export interface RotationResult {
  path: string;
  rotated: boolean;
  bytes: number;
}

/**
 * Rotate one log file if it exceeds `maxBytes`. Returns what happened so the
 * caller can log it (the rotation itself is the first thing written to the
 * fresh file, which is exactly where you want that note).
 */
export function rotateIfOversized(
  path: string,
  maxBytes: number = DEFAULT_MAX_LOG_BYTES,
): RotationResult {
  if (!existsSync(path)) return { path, rotated: false, bytes: 0 };

  let bytes: number;
  try {
    bytes = statSync(path).size;
  } catch {
    return { path, rotated: false, bytes: 0 };
  }
  if (bytes <= maxBytes) return { path, rotated: false, bytes };

  try {
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    return { path, rotated: true, bytes };
  } catch {
    // Rotation is best-effort: a daemon that cannot rotate its log must still
    // boot and serve Slack.
    return { path, rotated: false, bytes };
  }
}

/** Rotate every oversized daemon log, returning only the ones that rotated. */
export function rotateDaemonLogs(
  logDir: string,
  maxBytes: number = DEFAULT_MAX_LOG_BYTES,
): RotationResult[] {
  return ['stdout.log', 'stderr.log']
    .map((name) => rotateIfOversized(`${logDir}/${name}`, maxBytes))
    .filter((result) => result.rotated);
}
