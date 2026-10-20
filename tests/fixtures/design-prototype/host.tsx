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
import { TokenSetForm, type TokenSetFormProps } from '@editor-platform/template-ui';
import type { TokenSet } from '@editor-platform/reuse-core';
import { prototypeFixture } from './content';
import '@editor-platform/editor-ui/styles.css';
function Host() {
  const params = new URLSearchParams(location.search);
  const contracts = params.has('host-contracts');
  const [session] = useState(() => {
    const retained = sessionStorage.getItem('design-prototype-native');
    const content: DesignContent = retained ? JSON.parse(retained) : prototypeFixture();
    if (!retained && params.has('legacy')) delete content.prototyping;
    return new EditorSession<DesignContent>(content);
  });
  const [compactBreakpoint, setCompactBreakpoint] = useState(1100);
  const [width, setWidth] = useState(1040);
  const [tokens, setTokens] = useState<TokenSet>({
    schemaVersion: 1,
    modes: ['light', 'dark'],
    defaultMode: 'light',
    tokens: {
      'brand.color': {
        type: 'color',
        value: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 1 },
      },
    },
  });
  const [tokenChanges, setTokenChanges] = useState(0);
  const [tokenSubmissions, setTokenSubmissions] = useState(0);
  const tokenProps: TokenSetFormProps = {
    value: tokens,
    onChange: (next) => {
      setTokenChanges((count) => count + 1);
      setTokens(next);
    },
  };
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
      {contracts && (
        <>
          <label>
            Host compact breakpoint
            <input
              aria-label="Host compact breakpoint"
              type="number"
              value={compactBreakpoint}
              onChange={(e) => setCompactBreakpoint(e.currentTarget.valueAsNumber)}
            />
          </label>
          <label>
            Host container width
            <input
              aria-label="Host container width"
              type="number"
              value={width}
              onChange={(e) => setWidth(e.currentTarget.valueAsNumber)}
            />
          </label>
        </>
      )}
      <div style={{ height: '82vh', width: contracts ? `min(100%, ${width}px)` : '100%' }}>
        {editing ? (
          <DesignSurface
            content={session.content}
            select={() => {}}
            readOnly={readOnly}
            prototype={prototype}
            layout={contracts ? { compactBreakpoint } : undefined}
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
      {contracts && (
        <>
          <button
            type="button"
            onClick={() =>
              setTokens({
                ...tokens,
                modes: ['day', 'night'],
                defaultMode: 'day',
                tokens: {
                  ...tokens.tokens,
                  'brand.color': {
                    ...tokens.tokens['brand.color'],
                    description: 'Host replacement',
                  },
                },
              })
            }
          >
            Host replace token draft
          </button>
          <button
            type="button"
            onClick={() => setTokens({ ...tokens, modes: ['light', 'dark'], defaultMode: 'light' })}
          >
            Host reset token modes
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTokenSubmissions((count) => count + 1);
            }}
          >
            <TokenSetForm {...tokenProps} />
            <button type="submit">Host publish tokens</button>
          </form>
          <output aria-label="Host token changes">{tokenChanges}</output>
          <output aria-label="Host token submissions">{tokenSubmissions}</output>
          <pre style={{ maxWidth: '100%', overflow: 'auto' }} data-testid="host-tokens">
            {JSON.stringify(tokens)}
          </pre>
        </>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
