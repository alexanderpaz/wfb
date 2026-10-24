import type { PreviewKind } from '@wfb/contracts';
import { extensionOf, isOfficeFile, isPreviewable } from '../storage/entries.js';

/** Images browsers render natively; served as-is (except SVG, which is always rasterized). */
const NATIVE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);

/** Extension → highlight.js language id (also valid Monaco ids for the common ones). */
const LANGUAGES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json',
  py: 'python', java: 'java', go: 'go', rs: 'rust', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', swift: 'swift', dart: 'dart', lua: 'lua', pl: 'perl', r: 'r',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', m: 'objectivec',
  php: 'php', rb: 'ruby', sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', bat: 'dos', cmd: 'dos',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties', env: 'bash',
  dockerfile: 'dockerfile', makefile: 'makefile', csv: 'plaintext', tsv: 'plaintext',
  txt: 'plaintext', log: 'plaintext', rst: 'plaintext', gitignore: 'plaintext',
}; // prettier-ignore

const TEXT_MIME =
  /^(text\/.+|application\/(json|xml|yaml|x-yaml|toml|javascript|x-sh|sql|.+\+json|.+\+xml))$/;

export interface PreviewClass {
  kind: PreviewKind;
  /** True for images that must be rasterized before reaching the browser (SVG, TIFF, HEIC...). */
  rasterize: boolean;
  language: string | null;
}

const NONE: PreviewClass = { kind: 'none', rasterize: false, language: null };

export function classify(name: string, mime: string, opts: { office: boolean }): PreviewClass {
  const ext = extensionOf(name);
  if (ext === 'svg' || mime === 'image/svg+xml') return { kind: 'image', rasterize: true, language: null };
  if (NATIVE_IMAGE_EXTENSIONS.has(ext)) return { kind: 'image', rasterize: false, language: null };
  if (mime.startsWith('image/')) return { kind: 'image', rasterize: true, language: null };
  if (mime === 'application/pdf') return { kind: 'pdf', rasterize: false, language: null };
  if (VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/')) return { ...NONE, kind: 'video' };
  if (mime.startsWith('audio/')) return { ...NONE, kind: 'audio' };
  if (isOfficeFile(name)) return opts.office ? { ...NONE, kind: 'office' } : NONE;
  if (ext in LANGUAGES || TEXT_MIME.test(mime) || isPreviewable(name, mime, { office: false })) {
    return { kind: 'text', rasterize: false, language: LANGUAGES[ext] ?? 'plaintext' };
  }
  return NONE;
}
