import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { mountWorkspace } from './workspace.js';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import './styles.css';

function VaultWorkspace() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const host = document.createElement('div');
    // StrictMode remounts must never share a target with an earlier async mount.
    root.current.replaceChildren(host);
    void mountWorkspace(host).then(stop => {
      if (disposed) stop(); else cleanup = stop;
    }).catch((error: unknown) => {
      if (!disposed) host.textContent = error instanceof Error ? error.message : 'The workspace could not start. No local data was deleted.';
    });
    return () => { disposed = true; cleanup?.(); };
  }, []);
  return <div ref={root} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing application root.');
createRoot(container).render(<StrictMode><VaultWorkspace /></StrictMode>);


async function registerOfflineShell(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    const registration = await navigator.serviceWorker.ready;
    const urls = new Set<string>([window.location.href]);
    for (const entry of performance.getEntriesByType('resource')) {
      const value = (entry as PerformanceResourceTiming).name;
      try {
        if (new URL(value).origin === window.location.origin) urls.add(value);
      } catch {
        // Ignore opaque or malformed performance entries.
      }
    }
    registration.active?.postMessage({ type: 'CACHE_URLS', urls: [...urls] });
  } catch {
    // Offline-shell failure must never prevent access to local canonical data.
  }
}

void registerOfflineShell();
