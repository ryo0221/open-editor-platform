import React from 'react';
import { createRoot } from 'react-dom/client';
const root = createRoot(document.getElementById('code-root'), { onCaughtError() {} });
const diagnostic = (error) => (error instanceof Error ? error.message : String(error));
class PreviewBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error: diagnostic(error) };
  }
  componentDidCatch(error) {
    send('error', { message: diagnostic(error) });
  }
  render() {
    return this.state.error !== null ? (
      <pre role="alert" style={{ padding: 24, color: '#a53a32', whiteSpace: 'pre-wrap' }}>
        {this.state.error}
      </pre>
    ) : (
      this.props.children
    );
  }
}
let token = '',
  generation = 0;
const send = (type, data = {}) =>
  parent.postMessage({ channel: 'ep-code-preview', token, generation, type, ...data }, '*');
class HostSpeechRecognition {
  constructor() {
    this.generation = generation;
  }
  start() {
    if (this.generation !== generation) return;
    HostSpeechRecognition.active = this;
    send('request-microphone', { generation: this.generation });
  }
  stop() {
    if (HostSpeechRecognition.active === this && this.generation === generation)
      send('stop-microphone', { generation: this.generation });
  }
  abort() {
    this.stop();
  }
}
window.SpeechRecognition = HostSpeechRecognition;
let transcriptQueued = false,
  lastTranscript;
function syncTranscript() {
  if (transcriptQueued) return;
  transcriptQueued = true;
  window.queueMicrotask(() => {
    transcriptQueued = false;
    const el = document.querySelector('textarea');
    const text = el?.value ?? '';
    if (token && text !== lastTranscript) {
      lastTranscript = text;
      send('transcript', { text });
    }
  });
}
// React controlled values use the native setter and emit no input/mutation event.
// This bridge lives only inside the disposable opaque Code preview, never the Host.
const textareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
  ...textareaValue,
  set(value) {
    textareaValue.set.call(this, value);
    syncTranscript();
  },
});
addEventListener('input', syncTranscript);
const transcriptObserver = new MutationObserver(syncTranscript);
transcriptObserver.observe(document.getElementById('code-root'), {
  subtree: true,
  childList: true,
  characterData: true,
});
addEventListener('message', (e) => {
  if (e.source !== parent || e.data?.channel !== 'ep-code-host') return;
  const d = e.data;
  if (d.type === 'connect') {
    send('ready');
  } else if (d.type === 'render') {
    token = d.token;
    generation = d.generation;
    HostSpeechRecognition.active = undefined;
    lastTranscript = undefined;
    try {
      const module = { exports: {} };
      new Function('require', 'module', 'exports', d.code)(
        (name) => {
          if (name === 'react') return React;
          throw Error('Unsupported import: ' + name);
        },
        module,
        module.exports,
      );
      const Component = module.exports.default;
      if (typeof Component !== 'function')
        throw Error('default exportにReact Componentを指定してください。');
      root.render(
        <PreviewBoundary key={d.generation}>
          <Component />
        </PreviewBoundary>,
      );
      send('rendered');
    } catch (error) {
      root.render(
        <pre role="alert" style={{ padding: 24, color: '#a53a32', whiteSpace: 'pre-wrap' }}>
          {diagnostic(error)}
        </pre>,
      );
      send('error', { message: diagnostic(error) });
    }
  } else if (d.token === token && d.generation === generation && d.type === 'speech') {
    if (d.event === 'start') HostSpeechRecognition.active?.onstart?.({});
    if (d.event === 'end') HostSpeechRecognition.active?.onend?.({});
    if (d.event === 'error') HostSpeechRecognition.active?.onerror?.({ error: d.error });
    if (d.event === 'result') {
      const results = d.results.map((r) => {
        const a = [{ transcript: r.text, confidence: r.confidence }];
        a.isFinal = r.final;
        return a;
      });
      HostSpeechRecognition.active?.onresult?.({ results, resultIndex: 0 });
    }
  }
});

// Startup plus the Host's connect ping cover either listener/load ordering.
send('ready');
