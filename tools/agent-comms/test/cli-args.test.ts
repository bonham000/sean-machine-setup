import { describe, expect, it } from 'bun:test';
import { parseAgentCommsArgs, UsageError } from '../src/cli/args';

describe('parseAgentCommsArgs', () => {
  it('parses post with --text', () => {
    const args = parseAgentCommsArgs(['post', '--text', 'hello']);
    expect(args.subcommand).toBe('post');
    if (args.subcommand !== 'post') return;
    expect(args.text).toBe('hello');
    expect(args.json).toBe(false);
  });

  it('parses ask with --text', () => {
    const args = parseAgentCommsArgs(['ask', '--text', 'Q?']);
    expect(args.subcommand).toBe('ask');
    if (args.subcommand !== 'ask') return;
    expect(args.text).toBe('Q?');
    expect(args.timeoutSeconds).toBe(86400);
  });

  it('parses --timeout on ask', () => {
    const args = parseAgentCommsArgs([
      'ask',
      '--text',
      'Q?',
      '--timeout',
      '30s',
    ]);
    if (args.subcommand !== 'ask') throw new Error('expected ask');
    expect(args.timeoutSeconds).toBe(30);
  });

  it('parses --timeout=5m on ask', () => {
    const args = parseAgentCommsArgs([
      'ask',
      '--text',
      'Q?',
      '--timeout',
      '5m',
    ]);
    if (args.subcommand !== 'ask') throw new Error('expected ask');
    expect(args.timeoutSeconds).toBe(300);
  });

  it('parses --timeout=0 (indefinite) on ask', () => {
    const args = parseAgentCommsArgs(['ask', '--text', 'Q?', '--timeout', '0']);
    if (args.subcommand !== 'ask') throw new Error('expected ask');
    expect(args.timeoutSeconds).toBe(0);
  });

  it('parses --session-id', () => {
    const args = parseAgentCommsArgs([
      'post',
      '--text',
      'hi',
      '--session-id',
      'abc123',
    ]);
    if (args.subcommand !== 'post' && args.subcommand !== 'ask') return;
    expect(args.sessionId).toBe('abc123');
  });

  it('parses --json flag', () => {
    const args = parseAgentCommsArgs(['post', '--text', 'hi', '--json']);
    expect(args.json).toBe(true);
  });

  it('parses --cwd', () => {
    const args = parseAgentCommsArgs([
      'post',
      '--text',
      'hi',
      '--cwd',
      '/tmp/mydir',
    ]);
    if (args.subcommand !== 'post' && args.subcommand !== 'ask') return;
    expect(args.cwd).toBe('/tmp/mydir');
  });

  it('parses --port', () => {
    const args = parseAgentCommsArgs([
      'post',
      '--text',
      'hi',
      '--port',
      '9999',
    ]);
    expect(args.port).toBe(9999);
  });

  it('parses monitor --owner-token', () => {
    const args = parseAgentCommsArgs([
      'monitor',
      '--attachment',
      'att_123',
      '--owner-token',
      'tok_456',
    ]);
    expect(args.subcommand).toBe('monitor');
    if (args.subcommand !== 'monitor') return;
    expect(args.ownerToken).toBe('tok_456');
  });

  it('parses get-message with --message-id', () => {
    const args = parseAgentCommsArgs([
      'get-message',
      '--message-id',
      'msg_abc',
    ]);
    expect(args.subcommand).toBe('get-message');
    if (args.subcommand !== 'get-message') return;
    expect(args.messageId).toBe('msg_abc');
    expect(args.json).toBe(false);
  });

  it('parses get-message --json', () => {
    const args = parseAgentCommsArgs([
      'get-message',
      '--message-id',
      'msg_abc',
      '--json',
    ]);
    if (args.subcommand !== 'get-message') return;
    expect(args.json).toBe(true);
  });

  it('parses restart-after-reply without turn identifiers', () => {
    const args = parseAgentCommsArgs(['restart-after-reply', '--json']);
    expect(args).toEqual({
      subcommand: 'restart-after-reply',
      port: 42100,
      json: true,
    });
  });

  it('throws UsageError on get-message missing --message-id', () => {
    expect(() => parseAgentCommsArgs(['get-message'])).toThrow(UsageError);
  });

  it('throws UsageError on missing --text', () => {
    expect(() => parseAgentCommsArgs(['post'])).toThrow(UsageError);
  });

  it('throws UsageError on bad subcommand', () => {
    expect(() => parseAgentCommsArgs(['notify', '--text', 'hi'])).toThrow(
      UsageError,
    );
  });

  it('throws UsageError on empty argv', () => {
    expect(() => parseAgentCommsArgs([])).toThrow(UsageError);
  });

  it('throws UsageError on --timeout for post', () => {
    expect(() =>
      parseAgentCommsArgs(['post', '--text', 'hi', '--timeout', '30s']),
    ).toThrow(UsageError);
  });

  it('throws UsageError on --owner-token for non-monitor commands', () => {
    expect(() =>
      parseAgentCommsArgs(['post', '--text', 'hi', '--owner-token', 'tok']),
    ).toThrow(UsageError);
  });

  it('throws UsageError on unknown flag', () => {
    expect(() =>
      parseAgentCommsArgs(['post', '--text', 'hi', '--unknown-flag']),
    ).toThrow(UsageError);
  });

  it('throws UsageError on bad --port value', () => {
    expect(() =>
      parseAgentCommsArgs(['post', '--text', 'hi', '--port', 'abc']),
    ).toThrow(UsageError);
  });

  it('throws UsageError on invalid --timeout format', () => {
    expect(() =>
      parseAgentCommsArgs(['ask', '--text', 'hi', '--timeout', 'forever']),
    ).toThrow(UsageError);
  });
});
