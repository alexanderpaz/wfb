import { normalizeVirtualPath } from '@wfb/contracts';
import { useCallback, useEffect, useState } from 'react';

export interface Location {
  share: string;
  path: string;
}

export const sameLocation = (a: Location, b: Location) => a.share === b.share && a.path === b.path;

function readUrl(): Location {
  const params = new URLSearchParams(window.location.search);
  return {
    share: params.get('share') ?? '',
    path: normalizeVirtualPath(params.get('path') ?? '/') ?? '/',
  };
}

function writeUrl(loc: Location) {
  const url = new URL(window.location.href);
  if (url.searchParams.get('share') === loc.share && url.searchParams.get('path') === loc.path) return;
  url.searchParams.set('share', loc.share);
  url.searchParams.set('path', loc.path);
  window.history.replaceState(window.history.state, '', url);
}

interface HistoryState {
  entries: Location[];
  index: number;
}

/**
 * Explorer navigation with its own back/forward stack; the current location is
 * mirrored in the query string (`?share=x&path=/a/b`) so reloads keep it.
 */
export function useNavigation() {
  const [state, setState] = useState<HistoryState>(() => ({ entries: [readUrl()], index: 0 }));
  const location = state.entries[state.index]!;

  useEffect(() => {
    if (location.share) writeUrl(location);
  }, [location]);

  const navigate = useCallback((loc: Location) => {
    setState((s) => {
      const current = s.entries[s.index]!;
      if (sameLocation(current, loc)) return s;
      const entries = [...s.entries.slice(0, s.index + 1), loc].slice(-100);
      return { entries, index: entries.length - 1 };
    });
  }, []);

  const replace = useCallback((loc: Location) => {
    setState((s) => {
      const entries = [...s.entries];
      entries[s.index] = loc;
      return { entries, index: s.index };
    });
  }, []);

  const go = useCallback((delta: number) => {
    setState((s) => {
      const index = Math.min(s.entries.length - 1, Math.max(0, s.index + delta));
      return index === s.index ? s : { ...s, index };
    });
  }, []);

  const back = useCallback(() => go(-1), [go]);
  const forward = useCallback(() => go(1), [go]);

  return {
    location,
    navigate,
    replace,
    back,
    forward,
    canBack: state.index > 0,
    canForward: state.index < state.entries.length - 1,
    backTarget: state.entries[state.index - 1],
    forwardTarget: state.entries[state.index + 1],
  };
}
