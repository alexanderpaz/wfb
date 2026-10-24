import { describe, expect, it } from 'vitest';
import { DownloadQuery } from './files.js';
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

describe('QueryBoolean', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['', true],
    ['false', false],
    ['0', false],
  ])('%s -> %s', (input, expected) => {
    expect(DownloadQuery.parse({ share: 's', path: '/a', inline: input }).inline).toBe(expected);
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
