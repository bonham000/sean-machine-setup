/**
 * Parse a duration string into seconds.
 *
 * Accepts: '<N>s' (seconds), '<N>m' (minutes), '<N>h' (hours), '0' (indefinite).
 * Throws on unrecognised formats.
 */
export function parseDuration(input: string): number {
  if (input === '0') return 0;
  const match = /^(\d+)(s|m|h)$/.exec(input);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Accepted formats: 30s, 5m, 1h, 24h, 0 (indefinite).`,
    );
  }
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  return n * 3600; // 'h'
}

