import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AnimationHostSurface as AnimationSurface } from '@editor-platform/animation/host';
import { AnimationViewer } from '@editor-platform/animation/viewer';
import {
  createAnimation2,
  readAnimationHostContent,
  type AnimationHostContent,
} from '@editor-platform/animation-core/v2';
import {
  EditorSession,
  EditorInputs,
  sameLocalRevision,
  type EditorCommand,
} from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import {
  createArtifact,
  serializeArtifact,
  updateDraft,
  commitVersion,
} from '@editor-platform/artifact-core';
import { readAnimationHostArtifact, savedAnimationEmbed } from './model';
import { ReactComposition, type ReactPreviewRuntime } from '@editor-platform/react-ui-preview';
import { reactComponentKey } from '@editor-platform/react-ui-core';
import { RegisteredAnimationPlayer } from './registered-player';
import {
  createAnimationReactDocument,
  animationReactComponent,
  animationReactResolution,
} from './react-registration';
import './style.css';

/** Independent local Host: only public packages, no Playground store/CSS or extension service. */
function Host() {
  const [artifact, setArtifact] = useState(() =>
    createArtifact<AnimationHostContent>('animation', 'Animation', createAnimation2()),
  );
  const latest = useRef(artifact);
  latest.current = artifact;
  const [session, setSession] = useState(
    () => new EditorSession<AnimationHostContent>(artifact.draft.content),
  );
  const liveSession = useRef(session);
  liveSession.current = session;
  const inputs = useRef(new EditorInputs()).current;
  const [, render] = useState(0),
    [readOnly, setReadOnly] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [reactDocument, setReactDocument] =
    useState<ReturnType<typeof createAnimationReactDocument>>();
  const [view, setView] = useState<'edit' | 'player' | 'react'>('edit');
  const canEdit = useRef(true);
  canEdit.current = !readOnly && !busy;
  const execute = (command: EditorCommand<AnimationHostContent>) => {
    if (!canEdit.current) return false;
    try {
      session.execute({
        ...command,
        apply: (content) => readAnimationHostContent(command.apply(content)),
      });
      const next = updateDraft(latest.current, readAnimationHostContent(session.content));
      latest.current = next;
      setArtifact(next);
      render((v) => v + 1);
      setError('');
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    }
  };
  const flush = () => {
    flushSync(() => inputs.flush());
  };
  const native = () => ({
    ...latest.current,
    draft: { ...latest.current.draft, content: readAnimationHostContent(session.content) },
  });
  const history = (direction: 'undo' | 'redo') => {
    if (!canEdit.current) return;
    try {
      flush();
      if (direction === 'undo') session.undo();
      else session.redo();
      const next = updateDraft(latest.current, readAnimationHostContent(session.content));
      latest.current = next;
      setArtifact(next);
      render((v) => v + 1);
    } catch (error) {
      setError(String(error));
    }
  };
  const save = async () => {
    if (!canEdit.current) return;
    try {
      flush();
      const captured = native();
      setBusy(true);
      const saved = await commitVersion(captured, 'reference-host', 'Saved Animation');
      savedAnimationEmbed(saved);
      localStorage.setItem('animation-reference-native', serializeArtifact(saved));
      setArtifact(saved);
      latest.current = saved;
      setError('');
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const load = async (text: string) => {
    if (!canEdit.current) throw Error('Read only');
    flush();
    const base = session.revision;
    const owned = await readAnimationHostArtifact(text);
    if (!canEdit.current) throw Error('Read only');
    const pending = inputs.getSnapshot();
    if (pending.dirty || pending.composing)
      throw Error('Animation inputs changed during import; apply or finish them before importing');
    if (liveSession.current !== session || !sameLocalRevision(base, session.revision))
      throw Error('Animation changed during import');
    setArtifact(owned);
    latest.current = owned;
    setSession(new EditorSession<AnimationHostContent>(owned.draft.content));
    setView('edit');
    setError('');
  };
  const embed = savedAnimationEmbed(artifact);
  const reactRuntime: ReactPreviewRuntime = {
    resolution: animationReactResolution,
    components: {
      [reactComponentKey(animationReactComponent.ref)]:
        RegisteredAnimationPlayer as unknown as ReactPreviewRuntime['components'][string],
    },
    providers: {},
    assets: {},
  };
  return (
    <EditorInputsContext.Provider value={inputs}>
      <header>
        <h1>Animation independent Host</h1>
        <button disabled={readOnly || busy} onClick={() => history('undo')}>
          Undo
        </button>
        <button disabled={readOnly || busy} onClick={() => history('redo')}>
          Redo
        </button>
        <button disabled={readOnly || busy} onClick={() => void save()}>
          Save version
        </button>
        <button
          disabled={busy}
          onClick={() => {
            try {
              flush();
              const blob = new Blob([serializeArtifact(native())], { type: 'application/json' });
              const url = URL.createObjectURL(blob),
                link = document.createElement('a');
              link.href = url;
              link.download = 'animation-native.json';
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (error) {
              setError(String(error));
            }
          }}
        >
          Native JSON
        </button>
        <button
          disabled={readOnly || busy}
          onClick={() => {
            const stored = localStorage.getItem('animation-reference-native');
            if (stored) void load(stored).catch((error) => setError(String(error)));
          }}
        >
          Reload saved
        </button>
        <label>
          Import native
          <input
            aria-label="Import Animation native"
            type="file"
            accept=".json"
            disabled={readOnly || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void file
                  .text()
                  .then(load)
                  .catch((error) => setError(String(error)));
              e.currentTarget.value = '';
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="Read only"
            checked={readOnly}
            onChange={(e) => {
              const checked = e.target.checked;
              try {
                flush();
                setReadOnly(checked);
              } catch (error) {
                setError(String(error));
              }
            }}
          />
          Read only
        </label>
        <button
          disabled={!embed}
          onClick={() => {
            try {
              flush();
              setView((v) => (v === 'edit' ? 'player' : 'edit'));
            } catch (error) {
              setError(String(error));
            }
          }}
        >
          {view === 'edit' ? 'View saved Player' : 'Edit Animation'}
        </button>
        <button
          disabled={!embed || busy}
          onClick={() => {
            try {
              flush();
              setReactDocument(createAnimationReactDocument(embed!));
              setView('react');
            } catch (error) {
              setError(String(error));
            }
          }}
        >
          View registered React Player
        </button>
        <output aria-label="Saved versions">{artifact.versions.length}</output>
      </header>
      {error && <p role="alert">{error}</p>}
      {view === 'react' && reactDocument ? (
        <section aria-label="Registered React Animation">
          <button onClick={() => setView('edit')}>Back to editor</button>
          <ReactComposition
            document={reactDocument}
            runtime={reactRuntime}
            inputs={{}}
            width={640}
          />
        </section>
      ) : view === 'edit' ? (
        <AnimationSurface
          key={session.revision.sessionId}
          sources={embed?.format === 'animation-embed-2' ? [embed] : []}
          artifactId={artifact.id}
          beforeCapture={() => {
            if (busy) throw Error('Wait for saving before export');
          }}
          canExport={() => !busy}
          content={session.content}
          session={session}
          inputs={inputs}
          readOnly={readOnly || busy}
          execute={execute}
          history={history}
          onError={(error) => setError(String(error))}
        />
      ) : (
        embed && (
          <main style={{ width: '100%', height: 440 }}>
            <AnimationViewer animation={embed} />
          </main>
        )
      )}
    </EditorInputsContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
