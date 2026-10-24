import { z } from 'zod';

/**
 * Normalizes a virtual path inside a share: POSIX separators, leading "/",
 * no trailing "/", no "." segments. Returns null when the path tries to escape
 * the share root ("..") or contains NUL bytes.
 */
export function normalizeVirtualPath(input: string): string | null {
  if (input.includes('\0')) return null;
  const segments: string[] = [];
  for (const raw of input.replace(/\\/g, '/').split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') return null;
    segments.push(raw);
  }
  return '/' + segments.join('/');
}

export const VirtualPath = z
  .string()
  .max(4096)
  .transform((value, ctx) => {
    const normalized = normalizeVirtualPath(value);
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid path' });
      return z.NEVER;
    }
    return normalized;
  });

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return path.slice(idx + 1);
}

export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}
