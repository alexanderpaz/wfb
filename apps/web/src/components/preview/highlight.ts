import type { HLJSApi, LanguageFn } from 'highlight.js';

type Loader = () => Promise<{ default: LanguageFn }>;

/** Languages are separate lazy chunks; only highlight.js core is shared. */
const LANGUAGES: Record<string, Loader> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dart: () => import('highlight.js/lib/languages/dart'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  dos: () => import('highlight.js/lib/languages/dos'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  properties: () => import('highlight.js/lib/languages/properties'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  python: () => import('highlight.js/lib/languages/python'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};

/** Highlighting very large files freezes the tab; above this they are shown as plain text. */
export const MAX_HIGHLIGHT_CHARS = 256 * 1024;

let core: Promise<HLJSApi> | null = null;

export function canHighlight(language: string | null | undefined): language is string {
  return !!language && language in LANGUAGES;
}

/** Returns escaped HTML with `hljs-*` spans, or null when the language is unknown or the text too big. */
export async function highlight(text: string, language: string | null | undefined): Promise<string | null> {
  if (!canHighlight(language) || text.length > MAX_HIGHLIGHT_CHARS) return null;
  core ??= import('highlight.js/lib/core').then((m) => m.default);
  const hljs = await core;
  if (!hljs.getLanguage(language)) {
    hljs.registerLanguage(language, (await LANGUAGES[language]!()).default);
  }
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}
