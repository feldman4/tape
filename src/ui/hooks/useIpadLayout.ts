import { useEffect, useState } from 'react';

function matchesIpadLayout(): boolean {
  return window.matchMedia('(pointer: coarse) and (orientation: landscape)').matches;
}

export function useIpadLayout(): boolean {
  const [enabled, setEnabled] = useState(matchesIpadLayout);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(pointer: coarse) and (orientation: landscape)');
    const update = () => setEnabled(mediaQuery.matches);
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);

  return enabled;
}