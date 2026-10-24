/** Reduces a client supplied file name to a safe basename, or null when unusable. */
export function sanitizeFileName(raw: string): string | null {
  const last = raw.split(/[/\\]/).pop() ?? '';
  const name = [...last]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  if (name === '' || name === '.' || name === '..' || Buffer.byteLength(name) > 255) return null;
  return name;
}

/** "name (n).ext" for files, "name (n)" for folders and dotfiles without extension. */
export function numberedName(name: string, n: number, isDirectory: boolean): string {
  const idx = isDirectory ? -1 : name.lastIndexOf('.');
  if (idx <= 0) return `${name} (${n})`;
  return `${name.slice(0, idx)} (${n})${name.slice(idx)}`;
}

/** First "name (n)" not taken according to `exists`. */
export async function freeName(
  name: string,
  isDirectory: boolean,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const candidate = numberedName(name, n, isDirectory);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No free name available for ${name}`);
}
