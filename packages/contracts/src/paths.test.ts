import { describe, expect, it } from 'vitest';
import { basename, dirname, joinPath, normalizeVirtualPath, VirtualPath } from './paths.js';

describe('normalizeVirtualPath', () => {
  it.each([
    ['', '/'],
    ['/', '/'],
    ['a/b', '/a/b'],
    ['/a//b/', '/a/b'],
    ['./a/./b', '/a/b'],
    ['\\a\\b', '/a/b'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeVirtualPath(input)).toBe(expected);
  });

  it.each(['..', '/a/../b', '../etc/passwd', 'a\0b'])('rejects %s', (input) => {
    expect(normalizeVirtualPath(input)).toBeNull();
    expect(VirtualPath.safeParse(input).success).toBe(false);
  });
});

describe('path helpers', () => {
  it('joins, basename and dirname', () => {
    expect(joinPath('/', 'a')).toBe('/a');
    expect(joinPath('/a', 'b')).toBe('/a/b');
    expect(basename('/a/b.txt')).toBe('b.txt');
    expect(dirname('/a/b.txt')).toBe('/a');
    expect(dirname('/a')).toBe('/');
  });
});
