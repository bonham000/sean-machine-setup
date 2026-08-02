import { describe, expect, it } from 'bun:test';
import { parseDuration } from '../src/cli/duration';

describe('parseDuration', () => {
  it('0 returns 0 (indefinite)', () => expect(parseDuration('0')).toBe(0));
  it('30s returns 30', () => expect(parseDuration('30s')).toBe(30));
  it('5m returns 300', () => expect(parseDuration('5m')).toBe(300));
  it('1h returns 3600', () => expect(parseDuration('1h')).toBe(3600));
  it('24h returns 86400', () => expect(parseDuration('24h')).toBe(86400));
  it('2h returns 7200', () => expect(parseDuration('2h')).toBe(7200));
  it('60s returns 60', () => expect(parseDuration('60s')).toBe(60));
  it('throws on bare number', () =>
    expect(() => parseDuration('30')).toThrow());
  it('throws on invalid unit', () =>
    expect(() => parseDuration('1d')).toThrow());
  it('throws on empty string', () => expect(() => parseDuration('')).toThrow());
  it('throws on arbitrary string', () =>
    expect(() => parseDuration('forever')).toThrow());
});

