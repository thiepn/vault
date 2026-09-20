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
