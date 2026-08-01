import { useEffect, useRef, useState } from 'react';
import { onNativeBrowserReset } from '../../lib/nativeBrowser';

export function useNativeBrowserResetGeneration(enabled: boolean, onReset?: () => void): number {
  const [generation, setGeneration] = useState(0);
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onNativeBrowserReset(() => {
      onResetRef.current?.();
      setGeneration((current) => current + 1);
    }).then((listener) => {
      if (disposed) listener();
      else unlisten = listener;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  return generation;
}
