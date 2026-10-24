import type { Readable } from 'node:stream';

export interface EntryInfo {
  name: string;
  /** Virtual path inside the share ("/" for the root). */
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: Date;
}

export interface TransferTarget {
  provider: StorageProvider;
  /** Virtual path of the entry to create (must not exist). */
  path: string;
}

/**
 * Storage backend rooted at a share. Every method takes virtual paths
 * (already normalized, starting with "/") and is responsible for keeping
 * operations inside the share.
 */
export interface StorageProvider {
  readonly kind: string;
  /** Absolute, symlink-free location of `path`; throws when it escapes the share. */
  realPath(path: string): Promise<string>;
  list(dir: string): Promise<EntryInfo[]>;
  stat(path: string): Promise<EntryInfo>;
  /** True when an entry exists at `path` (symlinks count, even dangling). */
  exists(path: string): Promise<boolean>;
  mkdir(dir: string, name: string): Promise<EntryInfo>;
  rename(path: string, newName: string): Promise<EntryInfo>;
  /** Recursive copy; the target must not exist. Symlinks are copied as links. */
  copy(src: string, target: TransferTarget): Promise<void>;
  /** Rename when possible, copy + delete across devices. The target must not exist. */
  move(src: string, target: TransferTarget): Promise<void>;
  /** Recursive delete. */
  remove(path: string): Promise<void>;
  createReadStream(path: string, range?: { start?: number; end?: number }): Promise<Readable>;
  /** Streams to a temp file in the same folder and renames it into place atomically. */
  writeFile(path: string, data: Readable, opts?: { overwrite?: boolean }): Promise<EntryInfo>;
}
