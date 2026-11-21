import { flushSync } from 'react-dom';
import { AnimationDesignImportPanel } from '@editor-platform/animation-adapters/design-ui';
import { AnimationHostSurface as AnimationSurface } from '@editor-platform/animation/host';
import { animationKind } from '@editor-platform/animation/kind';
import {
  readAnimationHostContent,
  readAnimation2,
  type AnimationHostContent,
} from '@editor-platform/animation-core/v2';
import type { EditorCommand, EditorSession } from '@editor-platform/editor-core';
import { designFrameSources } from '../../app/surface-sources';
import type { Content } from '../../model';
import { hostKind } from '../host-kind';
import type { SurfaceHost } from '../surface-host';

function AnimationLibrary({ host }: { host: SurfaceHost }) {
  const { sharedSession, session } = host;
  return (
    <>
      {host.animationCatalog.unavailable.map((entry, index) => (
        <p role="note" key={index}>
          {entry.label}: {entry.reason}
        </p>
      ))}
      <AnimationDesignImportPanel
        sources={designFrameSources([...host.savedRecords.current.values()])}
        inputs={host.inputs}
        readOnly={host.readOnly || host.busy}
        read={() => readAnimation2(sharedSession?.viewContent ?? session!.content)}
        execute={(command) => host.execute(command as EditorCommand<Content>)}
      />
    </>
  );
}

function AnimationHost({ host, content }: { host: SurfaceHost; content: AnimationHostContent }) {
  const { active, sharedSession, session, inputs, exportGuard } = host;
  return (
    <AnimationSurface
      artifactId={active.id}
      saving={host.busy}
      sources={host.animationCatalog.sources}
      content={content}
      beforeCapture={() => {
        flushSync(() => inputs.flush());
        exportGuard?.();
      }}
      canExport={() =>
        !sharedSession ||
        (!sharedSession.pendingCount && !sharedSession.rejected.length && !host.previewBlocked)
      }
      select={(ids, compositionId) => host.select([...ids], undefined, compositionId)}
      focusId={host.revealAddress?.elementId}
      library={content.schemaVersion === 2 ? <AnimationLibrary host={host} /> : undefined}
      session={session as EditorSession<AnimationHostContent>}
      inputs={inputs}
      read={() => readAnimationHostContent(sharedSession?.viewContent ?? session!.content)}
      textBridge={host.canvasText}
      readOnly={host.readOnly}
      execute={(cmd) =>
        host.execute<AnimationHostContent>({
          ...cmd,
          apply: (content) => readAnimationHostContent(cmd.apply(content)),
        })
      }
      history={host.history}
      onError={(error) => host.setError(String(error))}
    />
  );
}

export const animationSurface = hostKind(animationKind, { Surface: AnimationHost, session: 'any' });
