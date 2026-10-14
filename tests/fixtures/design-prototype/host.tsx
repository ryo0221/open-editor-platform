import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import {
  EditorSession,
  addAnnotation,
  type Annotation,
  type ElementAddress,
} from '@editor-platform/editor-core';
import { DesignSurface, DesignPrototypeSurface, type DesignContent } from '@editor-platform/design';
import { prototypeFixture } from './content';
import '@editor-platform/editor-ui/styles.css';
function Host() {
  const [session] = useState(() => {
    const retained = sessionStorage.getItem('design-prototype-native');
    return new EditorSession<DesignContent>(retained ? JSON.parse(retained) : prototypeFixture());
  });
  const [editing, setEditing] = useState(new URLSearchParams(location.search).has('edit'));
  const [readOnly, setReadOnly] = useState(false);
  const [accept, setAccept] = useState(true);
  const [, refresh] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [anchor, setAnchor] = useState<ElementAddress>();
  const [hash, setHash] = useState('');
  const snapshot = () => {
    refresh((v) => v + 1);
    void contentHash(session.content).then(setHash);
  };
  const prototype = {
    artifactId: 'independent',
    annotations,
    onFlowComplete: () => setCompleted((v) => v + 1),
    onAnnotationAnchor: setAnchor,
    onCreateAnnotation: (address: ElementAddress, body: string) => {
      if (readOnly || !accept) throw new Error('Host rejected comment');
      setAnnotations((a) => [...a, addAnnotation({ addresses: [address] }, body, 'Host')]);
    },
  };
  return (
    <>
      <button onClick={() => setEditing(!editing)}>Host mode</button>
      <label>
        <input
          type="checkbox"
          aria-label="Host read only"
          checked={readOnly}
          onChange={(e) => setReadOnly(e.target.checked)}
        />
        Read only
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="Host accepts commands"
          checked={accept}
          onChange={(e) => setAccept(e.target.checked)}
        />
        Accept commands
      </label>
      <button
        onClick={() => {
          sessionStorage.setItem('design-prototype-native', JSON.stringify(session.content));
          snapshot();
        }}
      >
        Host save
      </button>
      <button
        disabled={readOnly}
        onClick={() => {
          session.undo();
          snapshot();
        }}
      >
        Host undo
      </button>
      <button
        disabled={readOnly}
        onClick={() => {
          session.redo();
          snapshot();
        }}
      >
        Host redo
      </button>
      <output aria-label="Host flow completions">{completed}</output>
      <output aria-label="Host content hash">{hash}</output>
      <div style={{ height: '82vh', width: '100%' }}>
        {editing ? (
          <DesignSurface
            content={session.content}
            select={() => {}}
            readOnly={readOnly}
            prototype={prototype}
            execute={(cmd) => {
              if (readOnly || !accept) return false;
              session.execute(cmd);
              snapshot();
              return true;
            }}
          />
        ) : (
          <DesignPrototypeSurface content={session.content} {...prototype} />
        )}
      </div>
      <pre style={{ maxWidth: '100%', overflow: 'auto' }} data-testid="prototype-source">
        {canonicalJson(session.content)}
      </pre>
      <pre style={{ maxWidth: '100%', overflow: 'auto' }} data-testid="prototype-anchor">
        {JSON.stringify(anchor)}
      </pre>
      <pre style={{ maxWidth: '100%', overflow: 'auto' }} data-testid="prototype-annotations">
        {JSON.stringify(annotations)}
      </pre>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
