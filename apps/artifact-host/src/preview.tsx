import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
// This independently bundled Host contains React only, with no Editor runtime.
const root = createRoot(document.getElementById('root')!, {
  onCaughtError() {
    /* Boundary reports an addressed Host diagnostic. */
  },
});
let token = '',
  revision = 0;
const send = (type: string, message = '') =>
  parent.postMessage({ channel: 'artifact-preview', token, revision, type, message }, '*');
class Boundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error) {
    send('error', error.message);
  }
  render() {
    return this.state.error ? <p role="alert">{this.state.error}</p> : this.props.children;
  }
}
window.addEventListener('message', (event) => {
  const d = event.data;
  if (
    event.source !== parent ||
    d?.channel !== 'artifact-host' ||
    d.type !== 'render' ||
    typeof d.token !== 'string' ||
    !Number.isSafeInteger(d.revision) ||
    typeof d.entry !== 'string' ||
    !d.modules ||
    typeof d.modules !== 'object'
  )
    return;
  token = d.token;
  revision = d.revision;
  try {
    const cache = new Map<string, { exports: Record<string, unknown> }>();
    const load = (filename: string): Record<string, unknown> => {
      if (cache.has(filename)) return cache.get(filename)!.exports;
      if (!Object.hasOwn(d.modules, filename) || typeof d.modules[filename] !== 'string')
        throw Error('Missing isolated module: ' + filename);
      const module = { exports: {} as Record<string, unknown> };
      cache.set(filename, module);
      const require = (name: string): unknown => {
        if (name === 'react') return React;
        if (name === 'react/jsx-runtime') return jsxRuntime;
        if (!name.startsWith('./') || name.includes('..'))
          throw Error('Unsupported import: ' + name);
        if (name.endsWith('.css')) return {};
        const base = filename.slice(0, filename.lastIndexOf('/') + 1);
        return load(base + name.slice(2) + (name.endsWith('.tsx') ? '' : '.tsx'));
      };
      // Host-owned code runner, inside allow-scripts-only opaque CSP sandbox.
      new Function('require', 'module', 'exports', d.modules[filename])(
        require,
        module,
        module.exports,
      );
      return module.exports;
    };
    const C = load(d.entry)[d.symbol] as React.ComponentType;
    if (typeof C !== 'function') throw Error('Missing exported React component: ' + d.symbol);
    root.render(
      <Boundary key={revision}>
        <style>{d.css}</style>
        <C />
      </Boundary>,
    );
    send('rendered');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.render(<p role="alert">{message}</p>);
    send('error', message);
  }
});
