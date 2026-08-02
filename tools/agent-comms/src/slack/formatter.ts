/**
 * Convert Markdown text from Claude Code into Slack mrkdwn.
 *
 * Slack mrkdwn ≠ standard Markdown. Differences this module handles:
 *   - **bold** → *bold*  (only outside code spans / fences)
 *   - [text](url) → <url|text>
 *   - # / ## / ### headings → *bold* (Slack has no heading syntax)
 *
 * Italics are intentionally NOT converted: Markdown `*italic*` collides with
 * Slack's bold marker, and CC output rarely uses single-asterisk italics.
 * Bullet `-` / `*` lines pass through unchanged — Slack renders them fine.
 *
 * Truncation: Slack's chat.postMessage cap is 40000 chars. We leave 80 chars
 * of headroom for the suffix.
 */

const MAX_CHARS = 40000;
const TRUNCATION_SUFFIX =
  '\n\n_… (truncated — answer exceeded Slack message limit)_';

interface Segment {
  kind: 'code' | 'text';
  body: string;
}

function splitOnCodeFences(input: string): Segment[] {
  const segments: Segment[] = [];
  const fenceRe = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = fenceRe.exec(input);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({
        kind: 'text',
        body: input.slice(lastIndex, match.index),
      });
    }
    segments.push({ kind: 'code', body: match[0] });
    lastIndex = match.index + match[0].length;
    match = fenceRe.exec(input);
  }
  if (lastIndex < input.length) {
    segments.push({ kind: 'text', body: input.slice(lastIndex) });
  }
  return segments;
}

function transformTextSegment(text: string): string {
  // Protect inline `code` spans: split on backticks, transform only outside.
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // inline code, leave untouched
      let out = part;
      // Markdown links → Slack links
      out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
      // Bold: **text** → *text*
      out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
      // Headings at line start: replace markers with bold wrapper
      out = out.replace(
        /^(#{1,6})\s+(.+?)\s*$/gm,
        (_, _hashes, body) => `*${body}*`,
      );
      return out;
    })
    .join('');
}

export function toSlackMrkdwn(input: string): string {
  if (!input) return '';
  const segments = splitOnCodeFences(input);
  const transformed = segments
    .map((seg) =>
      seg.kind === 'code' ? seg.body : transformTextSegment(seg.body),
    )
    .join('');
  return truncate(transformed);
}

export function truncate(input: string, maxChars: number = MAX_CHARS): string {
  if (input.length <= maxChars) return input;
  const limit = maxChars - TRUNCATION_SUFFIX.length;
  return input.slice(0, Math.max(0, limit)) + TRUNCATION_SUFFIX;
}

