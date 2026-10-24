import type { FileEntry } from '@wfb/contracts';

export type FileKind =
  | 'folder'
  | 'image'
  | 'pdf'
  | 'text'
  | 'code'
  | 'audio'
  | 'video'
  | 'archive'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'generic';

const EXT_KIND: Record<string, FileKind> = {};
const register = (kind: FileKind, exts: string) => exts.split(' ').forEach((e) => (EXT_KIND[e] = kind));
register('image', 'png jpg jpeg gif bmp svg webp ico tif tiff heic avif');
register('pdf', 'pdf');
register('text', 'txt md log csv rtf ini cfg conf');
register(
  'code',
  'ts tsx js jsx mjs cjs json py rb go rs java c h cpp hpp cs php html htm css scss xml yaml yml sh bat ps1 sql toml vue',
);
register('audio', 'mp3 wav ogg flac m4a aac wma');
register('video', 'mp4 mov avi mkv webm wmv m4v');
register('archive', 'zip rar 7z tar gz tgz bz2 xz iso');
register('word', 'doc docx odt');
register('excel', 'xls xlsx ods');
register('powerpoint', 'ppt pptx odp');

export function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Name without extension, used to pre-select the editable part on rename. */
export function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function fileKind(entry: Pick<FileEntry, 'name' | 'type' | 'mime'>): FileKind {
  if (entry.type === 'directory') return 'folder';
  const byExt = EXT_KIND[extension(entry.name)];
  if (byExt) return byExt;
  const mime = entry.mime ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/pdf') return 'pdf';
  return 'generic';
}

const LABELS: Record<string, string> = {
  pdf: 'Documento PDF',
  png: 'Imagen PNG',
  jpg: 'Imagen JPEG',
  jpeg: 'Imagen JPEG',
  gif: 'Imagen GIF',
  bmp: 'Imagen BMP',
  webp: 'Imagen WEBP',
  svg: 'Documento SVG',
  ico: 'Icono',
  txt: 'Documento de texto',
  md: 'Archivo de Markdown',
  csv: 'Archivo CSV',
  log: 'Documento de texto',
  json: 'Archivo JSON',
  ts: 'Archivo TypeScript',
  tsx: 'Archivo TypeScript',
  js: 'Archivo JavaScript',
  py: 'Archivo Python',
  html: 'Documento HTML',
  css: 'Hoja de estilos CSS',
  doc: 'Documento de Microsoft Word 97-2003',
  docx: 'Documento de Microsoft Word',
  xls: 'Hoja de cálculo de Microsoft Excel 97-2003',
  xlsx: 'Hoja de cálculo de Microsoft Excel',
  ppt: 'Presentación de Microsoft PowerPoint 97-2003',
  pptx: 'Presentación de Microsoft PowerPoint',
  zip: 'Carpeta comprimida (zip)',
  mp3: 'Archivo MP3',
  mp4: 'Archivo MP4',
  wav: 'Sonido WAV',
};

export function typeLabel(entry: Pick<FileEntry, 'name' | 'type'>): string {
  if (entry.type === 'directory') return 'Carpeta de archivos';
  const ext = extension(entry.name);
  if (!ext) return 'Archivo';
  return LABELS[ext] ?? `Archivo ${ext.toUpperCase()}`;
}

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'];

/** Human readable size with Spanish formatting, e.g. "1,5 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat('es', { maximumFractionDigits: digits }).format(value)} ${UNITS[unit]}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function countLabel(n: number, singular = 'elemento', plural = 'elementos'): string {
  return `${new Intl.NumberFormat('es').format(n)} ${n === 1 ? singular : plural}`;
}
