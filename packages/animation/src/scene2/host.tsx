import { useRef, useState } from 'react';
import type { EditorCommand, EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { readAnimationV1 } from '@editor-platform/animation-core';
import {
  readAnimation2,
  upgradeAnimationCommand2,
  type AnimationHostContent,
} from '@editor-platform/animation-core/v2';
import type { CanvasTextBridge } from '@editor-platform/canvas-ui';
import { AnimationViewer } from '../viewer';
import { createPlayableAnimationEmbed } from '@editor-platform/animation-core/v2';
import { reuseHash } from '@editor-platform/reuse-core';
import { AnimationSurface2 } from './surface';
export interface AnimationHostSurfaceProps {
  beforeCapture?(): void;
  canExport?(): boolean;
  select?(ids: readonly string[], compositionId: string): void;
  focusId?: string;
  sources?: readonly import('@editor-platform/animation-core/v2').AnimationEmbed2[];
  library?: import('react').ReactNode;
  artifactId: string;
  content: AnimationHostContent;
  session?: EditorSession<AnimationHostContent>;
  inputs: EditorInputs;
  readOnly: boolean;
  saving?: boolean;
  read?(): AnimationHostContent;
  execute(command: EditorCommand<AnimationHostContent>): boolean | void;
  history(direction: 'undo' | 'redo'): void;
  onError(error: unknown): void;
  textBridge?(id: string): CanvasTextBridge;
}
/** One current editor. Legacy drafts are read-only until an explicit history transaction migrates them. */
export function AnimationHostSurface(props: AnimationHostSurfaceProps) {
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState('');
  const read = () =>
    latest.current.read?.() ?? latest.current.session?.content ?? latest.current.content;
  if (props.content.schemaVersion === 2)
    return (
      <AnimationSurface2
        content={props.content}
        beforeCapture={props.beforeCapture}
        canExport={props.canExport}
        select={props.select}
        focusId={props.focusId}
        library={props.library}
        sources={props.sources}
        inputs={props.inputs}
        readOnly={props.readOnly || !!props.saving}
        read={() => readAnimation2(read())}
        execute={(command) =>
          props.execute({ ...command, apply: (content) => command.apply(readAnimation2(content)) })
        }
        history={props.history}
        textBridge={props.textBridge}
        onError={props.onError}
      />
    );
  return (
    <section aria-label="Animation migration">
      <p>
        この下書きは旧形式です。編集を始めるには、新しい形式へ変換してください。保存済みの版は保持されます。
      </p>
      <button
        disabled={props.readOnly || props.saving}
        onClick={() => {
          try {
            props.inputs.flush();
            const command = upgradeAnimationCommand2(readAnimationV1(read()), {
              canEdit: () => !latest.current.readOnly && !latest.current.saving,
            });
            if (props.execute(command) === false) throw Error('Upgrade refused');
            setError('');
          } catch (error) {
            setError(String(error));
          }
        }}
      >
        Animation を新しい形式へ変換
      </button>
      {error && <p role="alert">{error}</p>}
      <LegacyAnimationPreview artifactId={props.artifactId} content={props.content} />
    </section>
  );
}

function LegacyAnimationPreview(props: { artifactId: string; content: AnimationHostContent }) {
  try {
    const animation = createPlayableAnimationEmbed(
      {
        artifactId: props.artifactId,
        versionId: 'draft-preview',
        contentHash: reuseHash(props.content),
        compositionId: props.content.rootCompositionId,
      },
      props.content,
      'Animation',
    );
    return (
      <div style={{ height: 180 }}>
        <AnimationViewer animation={animation} />
      </div>
    );
  } catch (error) {
    return <p role="alert">Preview unavailable: {String(error)}</p>;
  }
}
