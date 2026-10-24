import type { FileEntry } from '@wfb/contracts';
import { lookup } from 'mime-types';
import type { EntryInfo } from './provider.js';

const MIME_OVERRIDES: Record<string, string> = {
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  mts: 'text/x-typescript',
  cts: 'text/x-typescript',
};

const TEXT_EXTENSIONS = new Set([
  'json', 'jsonc', 'json5', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'md', 'markdown', 'rst', 'txt', 'log', 'csv', 'tsv',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte',
  'py', 'rb', 'php', 'pl', 'lua', 'r', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'dart',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'm', 'sql', 'graphql', 'gql', 'proto',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'dockerfile', 'makefile', 'gitignore',
]); // prettier-ignore

const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'doc', 'xls', 'ppt']);

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx < 0 ? name.toLowerCase() : name.slice(idx + 1).toLowerCase();
}

export function mimeFor(name: string): string {
  const ext = extensionOf(name);
  return (
    MIME_OVERRIDES[ext] ??
    (lookup(name) || (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream'))
  );
}

export function isOfficeFile(name: string): boolean {
  return OFFICE_EXTENSIONS.has(extensionOf(name));
}

export function isPreviewable(name: string, mime: string, opts: { office: boolean }): boolean {
  if (/^(image|audio|video|text)\//.test(mime) || mime === 'application/pdf') return true;
  if (TEXT_EXTENSIONS.has(extensionOf(name))) return true;
  return opts.office && isOfficeFile(name);
}

export function toFileEntry(info: EntryInfo, opts: { office: boolean }): FileEntry {
  if (info.type === 'directory') {
    return { ...info, size: 0, modifiedAt: info.modifiedAt.toISOString(), mime: null, previewable: false };
  }
  const mime = mimeFor(info.name);
  return {
    ...info,
    modifiedAt: info.modifiedAt.toISOString(),
    mime,
    previewable: isPreviewable(info.name, mime, opts),
  };
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Folders first, then natural, accent/case-insensitive name order. */
export function compareEntries(a: { type: string; name: string }, b: { type: string; name: string }): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return collator.compare(a.name, b.name);
}
