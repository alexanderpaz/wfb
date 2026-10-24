import type { ReactNode, SVGProps } from 'react';
import type { Share } from '@wfb/contracts';
import type { FileKind } from './fileTypes';

/* File type icons (32×32 artboard, scaled) in the Windows 11 palette. */

const PAGE = 'M8 2.5h11.5L26.5 9.5V28a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 28V4A1.5 1.5 0 0 1 8 2.5z';
const FOLD = 'M19.5 2.5V8a1.5 1.5 0 0 0 1.5 1.5h5.5';

function Page({ children, fill = '#fff' }: { children?: ReactNode; fill?: string }) {
  return (
    <>
      <path d={PAGE} fill={fill} stroke="#8f8f8f" />
      <path d={FOLD} fill="#e6e6e6" stroke="#8f8f8f" strokeLinejoin="round" />
      {children}
    </>
  );
}

function Badge({ color, letter }: { color: string; letter: string }) {
  return (
    <>
      <rect x="2" y="13" width="14" height="14" rx="2" fill={color} />
      <text
        x="9"
        y="23.6"
        textAnchor="middle"
        fontSize="10"
        fontWeight="700"
        fontFamily="Segoe UI, Arial, sans-serif"
        fill="#fff"
      >
        {letter}
      </text>
    </>
  );
}

const Lines = ({ color = '#9e9e9e', from = 13 }: { color?: string; from?: number }) => (
  <g stroke={color} strokeWidth="1.5" strokeLinecap="round">
    <path d={`M10 ${from}h13M10 ${from + 4}h13M10 ${from + 8}h13M10 ${from + 12}h8`} />
  </g>
);

const KIND_ART: Record<FileKind, ReactNode> = {
  folder: (
    <>
      <path
        d="M2 7.5A2.5 2.5 0 0 1 4.5 5h7.1l3 3h12.9A2.5 2.5 0 0 1 30 10.5V25a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 25z"
        fill="#e8a623"
      />
      <path
        d="M2 12.5A1.5 1.5 0 0 1 3.5 11h25a1.5 1.5 0 0 1 1.5 1.5V25a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 25z"
        fill="#ffc83d"
      />
    </>
  ),
  archive: (
    <>
      <path
        d="M2 7.5A2.5 2.5 0 0 1 4.5 5h7.1l3 3h12.9A2.5 2.5 0 0 1 30 10.5V25a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 25z"
        fill="#c19c00"
      />
      <path
        d="M2 12.5A1.5 1.5 0 0 1 3.5 11h25a1.5 1.5 0 0 1 1.5 1.5V25a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 25z"
        fill="#f2c94c"
      />
      <path d="M17 11h3v2.5h-3zM20 13.5h3V16h-3zM17 16h3v2.5h-3zM20 18.5h3V21h-3z" fill="#7a5c00" />
      <rect x="16.5" y="21" width="7" height="4.5" rx="1" fill="#7a5c00" />
    </>
  ),
  generic: <Page />,
  text: (
    <Page>
      <Lines />
    </Page>
  ),
  code: (
    <Page>
      <path
        d="M13 15l-3.5 3.5L13 22M20 15l3.5 3.5L20 22M17.5 13.5l-2 10"
        fill="none"
        stroke="#8764b8"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Page>
  ),
  pdf: (
    <Page>
      <Lines color="#c8c8c8" from={8} />
      <Badge color="#d13438" letter="PDF" />
    </Page>
  ),
  word: (
    <Page>
      <Lines color="#9fb8e0" />
      <Badge color="#185abd" letter="W" />
    </Page>
  ),
  excel: (
    <Page>
      <g stroke="#9fd1b4" strokeWidth="1.3">
        <path d="M17 13h7M17 17h7M17 21h7M17 25h7M20.5 12v14" />
      </g>
      <Badge color="#107c41" letter="X" />
    </Page>
  ),
  powerpoint: (
    <Page>
      <circle cx="21" cy="17" r="4" fill="#f4b8a4" />
      <Badge color="#c43e1c" letter="P" />
    </Page>
  ),
  image: (
    <Page>
      <rect x="9" y="12" width="15" height="13" rx="1.5" fill="#cfe6fb" />
      <circle cx="19.5" cy="15.8" r="1.8" fill="#ffb900" />
      <path
        d="M9 23l4.5-5 3.5 3.8 2.2-2.3L24 24v-.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 9 23.5z"
        fill="#2e8b57"
      />
    </Page>
  ),
  audio: (
    <Page>
      <path
        d="M19.5 12.5v8.2a2.6 2.6 0 1 1-1.4-2.3V15l-4.8 1.2v6a2.6 2.6 0 1 1-1.4-2.3v-6.7z"
        fill="#e3008c"
      />
    </Page>
  ),
  video: (
    <Page>
      <rect x="9" y="13" width="15" height="11" rx="2" fill="#5c2e91" />
      <path d="M15 16v5l4.2-2.5z" fill="#fff" />
    </Page>
  ),
};

export function FileIcon({
  kind,
  size = 16,
  className,
}: {
  kind: FileKind;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      data-kind={kind}
    >
      {KIND_ART[kind]}
    </svg>
  );
}

export function ShareIcon({ visibility, size = 16 }: { visibility: Share['visibility']; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      {visibility === 'home' ? (
        <>
          <path
            d="M16 4 3 15h4v12.5A1.5 1.5 0 0 0 8.5 29H13v-8h6v8h4.5a1.5 1.5 0 0 0 1.5-1.5V15h4z"
            fill="#0f6cbd"
          />
          <path d="M13 21h6v8h-6z" fill="#cfe4fa" />
        </>
      ) : (
        <>
          <rect x="3" y="9" width="26" height="15" rx="2.5" fill="#6e7c8c" />
          <rect x="3" y="9" width="26" height="10" rx="2.5" fill="#8b9bad" />
          <circle cx="24" cy="20.5" r="1.4" fill="#5df28f" />
          <path d="M7 21.5h9" stroke="#d7dde4" strokeWidth="1.4" strokeLinecap="round" />
          {visibility === 'public' ? (
            <g transform="translate(16 13)">
              <circle cx="7.5" cy="7.5" r="7" fill="#0f6cbd" stroke="#fff" />
              <path
                d="M.5 7.5h14M7.5.5c-3.6 3.8-3.6 10.2 0 14M7.5.5c3.6 3.8 3.6 10.2 0 14"
                fill="none"
                stroke="#fff"
                strokeWidth="1.1"
              />
            </g>
          ) : (
            <g transform="translate(18 14)">
              <rect x="0" y="5" width="12" height="9" rx="1.6" fill="#c19c00" stroke="#fff" />
              <path d="M3 5V3.5a3 3 0 0 1 6 0V5" fill="none" stroke="#c19c00" strokeWidth="2" />
            </g>
          )}
        </>
      )}
    </svg>
  );
}

/* Monochrome UI glyphs (16×16, stroke follows currentColor). */

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function glyph(paths: ReactNode, viewBox = '0 0 16 16') {
  return function Glyph({ size = 16, ...rest }: GlyphProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

export const Icon = {
  Plus: glyph(<path d="M8 2.5v11M2.5 8h11" stroke="#0f6cbd" strokeWidth="1.5" />),
  Cut: glyph(
    <>
      <circle cx="4.5" cy="12" r="2" />
      <circle cx="11.5" cy="12" r="2" />
      <path d="M5.8 10.5 11.5 2M10.2 10.5 4.5 2" />
    </>,
  ),
  Copy: glyph(
    <>
      <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
      <path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v7A1.5 1.5 0 0 0 4 11.5h.5" />
    </>,
  ),
  Paste: glyph(
    <>
      <path d="M5.5 2.5H4A1.5 1.5 0 0 0 2.5 4v9.5A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V4A1.5 1.5 0 0 0 12 2.5h-1.5" />
      <rect x="5.5" y="1" width="5" height="3" rx="1" />
    </>,
  ),
  Rename: glyph(
    <>
      <rect x="1.5" y="4.5" width="13" height="7" rx="1.5" />
      <path d="M8 2v12M6.5 2h3M6.5 14h3" />
    </>,
  ),
  Delete: glyph(
    <>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.6a1.5 1.5 0 0 0 1.5 1.4h3.6a1.5 1.5 0 0 0 1.5-1.4L12 4" />
      <path d="M6.7 7v5M9.3 7v5" />
    </>,
  ),
  Download: glyph(<path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M3 13.5h10" />),
  Upload: glyph(<path d="M8 11V2.5M4.5 6 8 2.5 11.5 6M3 13.5h10" />),
  Sort: glyph(<path d="M4.5 2.5v11M2 11l2.5 2.5L7 11M11.5 13.5v-11M9 5l2.5-2.5L14 5" />),
  View: glyph(
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>,
  ),
  Details: glyph(<path d="M2 3.5h12M2 8h12M2 12.5h12" />),
  List: glyph(<path d="M2 3.5h1M5 3.5h4M2 8h1M5 8h4M2 12.5h1M5 12.5h4M11 3.5h1M11 8h1" />),
  LargeIcons: glyph(
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>,
  ),
  Pane: glyph(
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
    </>,
  ),
  NavPane: glyph(
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
    </>,
  ),
  Back: glyph(<path d="M13 8H3M7 4 3 8l4 4" />),
  Forward: glyph(<path d="M3 8h10M9 4l4 4-4 4" />),
  Up: glyph(<path d="M8 13V3M4 7l4-4 4 4" />),
  Refresh: glyph(<path d="M13.5 8A5.5 5.5 0 1 1 11.8 4M13.5 2v3.5H10" />),
  ChevronRight: glyph(<path d="M6 3.5 10.5 8 6 12.5" />),
  ChevronDown: glyph(<path d="M3.5 6 8 10.5 12.5 6" />),
  Search: glyph(
    <>
      <circle cx="6.8" cy="6.8" r="4.3" />
      <path d="m10 10 4 4" />
    </>,
  ),
  Open: glyph(
    <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3A1.5 1.5 0 0 1 10.5 14h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4h3" />,
  ),
  Info: glyph(
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 7.3v4M8 4.8v.2" />
    </>,
  ),
  Check: glyph(<path d="m3 8.5 3 3 7-7" />),
  Dot: glyph(<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />),
  NewFolder: glyph(
    <>
      <path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5.5v2" stroke="#c19c00" />
      <path d="M1.5 4v8A1.5 1.5 0 0 0 3 13.5h5" stroke="#c19c00" />
      <path d="M12 9v5M9.5 11.5h5" stroke="#0f6cbd" strokeWidth="1.4" />
    </>,
  ),
  Close: glyph(<path d="m4 4 8 8M12 4l-8 8" />),
  Warning: glyph(
    <>
      <path d="M8 2 1.5 13.5h13z" />
      <path d="M8 6.5v3.5M8 12v.2" />
    </>,
  ),
  Error: glyph(
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" />
    </>,
  ),
  Menu: glyph(<path d="M2 4h12M2 8h12M2 12h12" />),
};
