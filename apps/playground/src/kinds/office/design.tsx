import { memo, Suspense, useMemo, useRef, useState, type ComponentProps } from 'react';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { isDesign } from '@editor-platform/design';
import { designKind } from '@editor-platform/design/kind';
import { DesignReactSurface } from '@editor-platform/design-react';
import {
  convertDesignToReact,
  designReactSourceHash,
  applyDesignReactDocumentRegeneration,
  retainDesignPublications,
} from '@editor-platform/design-react-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { MangaArtTools } from 'virtual:playground-manga-tools';
import { registerReferenceNative } from '../../../../react-ui-reference/src/generated-registry';
import {
  referenceDesignRuntime,
  referenceDesignRegistrations,
  referenceDesignSettings,
  referenceDependencyDesignSettings,
} from '../../../../react-ui-reference/src/design-catalog';
import {
  referenceRuntimeAdapter,
  referenceTextRevision,
} from '../../../../react-ui-reference/src/catalog';
import { DesignInkTools, type DesignInkToolsControl } from '../../app/design-ink-tools';
import { designPageReviewHost } from '../../app/design-page-review';
import { readMangaWorkspace, writeMangaWorkspace } from '../../app/manga-workspace';
import { editedDraft } from '../../app/records';
import { createLocalSession, makeArtifact, type Content } from '../../model';
import { hostKind, type HostSurfaceProps, type KindContent } from '../host-kind';
import { latestRecord, type SurfaceHost } from '../surface-host';

const MemoDesignSurface = memo(function ReferenceDesignSurface(
  props: ComponentProps<typeof DesignReactSurface>,
) {
  // Playground replaces native content on edits. Keep that immutable snapshot stable
  // across pending-input/status renders so a pointer gesture retains its revision.
  const content = useMemo(() => deepFreeze(clone(props.content)), [props.content]);
  const runtime = useMemo(() => referenceDesignRuntime(content), [content]);
  const settings =
    new URLSearchParams(location.search).get('design-dependencies') === '1'
      ? referenceDependencyDesignSettings
      : props.settings;
  const registrations = useMemo(() => referenceDesignRegistrations(props.content), [props.content]);
  return (
    <DesignReactSurface
      {...props}
      content={content}
      settings={settings}
      runtime={runtime}
      registrations={registrations}
    />
  );
});

/** Registers a Design frame as a new native React UI artifact linked to its source. */
function registerGeneratedReact(
  host: SurfaceHost,
  source: Parameters<typeof convertDesignToReact>[0],
) {
  if (host.readOnly || host.sharedSession || !host.flushInputs())
    throw new Error('Register from a writable local Design artifact with confirmed inputs');
  const document = registerReferenceNative(source);
  if (host.execute(retainDesignPublications(convertDesignToReact(source))) === false)
    throw new Error('Native publication was rejected');
  const artifact = makeArtifact(
    'react-ui',
    host.records.filter((r) => r.kind === 'react-ui').length + 1,
  );
  artifact.draft.content = document;
  artifact.designReactConversion = {
    sourceArtifactId: host.active.id,
    sourceHash: designReactSourceHash(source),
    basis: clone(document),
  };
  host.sessions.current.set(artifact.id, createLocalSession(document));
  host.persist(artifact);
  host.activate(artifact.id);
}

type DesignProps = ComponentProps<typeof DesignReactSurface>;

/** Applies a reviewed regeneration only while source and target still match that review. */
function applyReactRegeneration(
  host: SurfaceHost,
  ...[id, sourceHash, review]: Parameters<NonNullable<DesignProps['applyRegeneration']>>
) {
  const { active } = host;
  if (host.readOnly || host.sharedSession)
    throw new Error(
      'Apply regeneration from a writable local artifact; shared targets require their authority session',
    );
  const target = latestRecord(host, id);
  if (
    !target?.designReactConversion ||
    reuseHash(target.designReactConversion.basis) !== review.from ||
    target.designReactConversion.sourceArtifactId !== active.id ||
    !isDesign(active.draft.content) ||
    designReactSourceHash(active.draft.content) !== sourceHash
  )
    throw new Error('Conversion source/target changed after review');
  const next = convertDesignToReact(active.draft.content);
  if (next.diagnostics.length) throw new Error('Resolve native conversion diagnostics first');
  registerReferenceNative(active.draft.content);
  host.execute(retainDesignPublications(next));
  const targetSession = host.sessions.current.get(id)!;
  const result = targetSession.executeView(
    applyDesignReactDocumentRegeneration(review) as EditorCommand<Content>,
  );
  host.persist({
    ...editedDraft(target, result),
    designReactConversion: {
      sourceArtifactId: active.id,
      sourceHash,
      basis: clone(next.document),
    },
  });
}

function DesignHost({ host, content }: HostSurfaceProps<KindContent<typeof designKind>>) {
  const { active, readOnly, sharedSession } = host;
  const latest = useRef(host);
  latest.current = host;
  const [workspaceChoice, setWorkspaceChoice] = useState<{
    id: string;
    workspace: 'design' | 'manga';
  }>();
  const workspace =
    workspaceChoice?.id === active.id ? workspaceChoice.workspace : readMangaWorkspace(active.id);
  const [inkFocus, setInkFocus] = useState<{ artifactId: string; id: string }>();
  const inkTools = useRef<DesignInkToolsControl>(null);
  const [rasterSelection, setRasterSelection] = useState<
    import('../../app/design-ink-proposal').InkContext['rasterSelection'] & { artifactId: string }
  >();
  return (
    <div className="playground-design-workspace">
      {!host.shared && (
        <DesignInkTools
          control={inkTools}
          key={active.id}
          host={host}
          rasterSelection={rasterSelection}
          onChoose={(id) => setInkFocus({ artifactId: active.id, id })}
        />
      )}
      {!host.shared && MangaArtTools && (
        <Suspense fallback={<p role="status">作画サンプルを読み込み中です。</p>}>
          <MangaArtTools key={active.id} host={host} />
        </Suspense>
      )}
      <MemoDesignSurface
        extension={
          !host.shared
            ? {
                toolbar: () => (
                  <button
                    className="design-ink-open"
                    onClick={(event) => inkTools.current?.open(event.currentTarget)}
                  >
                    作画ツールを開く
                  </button>
                ),
              }
            : undefined
        }
        workspace={workspace}
        onWorkspaceRequest={(workspace) => {
          setWorkspaceChoice({ id: active.id, workspace });
          writeMangaWorkspace(active.id, workspace);
        }}
        pageReview={host.shared ? undefined : designPageReviewHost(latest, active.id)}
        mangaReadOnlyReason={
          host.shared ? '共有セッションでは漫画のページ編集に対応していません。' : undefined
        }
        inkInput={!host.shared}
        rasterInput={!host.shared}
        onRasterSelection={(selection) =>
          setRasterSelection({ ...selection, artifactId: active.id })
        }
        focusRequest={inkFocus?.artifactId === active.id ? inkFocus : undefined}
        references={sharedSession ? undefined : host.references}
        focusReferenceId={host.revealAddress?.elementId}
        prototype={{
          artifactId: active.id,
          annotations: active.annotations,
          onCreateAnnotation: readOnly
            ? undefined
            : async (address, body) => {
                if (!(await host.addComment({ addresses: [address] }, body)))
                  throw new Error('Comment could not be created');
              },
          onFlowComplete: (event) => {
            host.setStatus(`Prototype flow completed: ${event.flowId}`);
          },
        }}
        content={content}
        runtime={referenceRuntimeAdapter}
        revisions={[
          { component: referenceTextRevision, propMap: { text: 'content' }, slotMap: {} },
        ]}
        registerGenerated={(source) => registerGeneratedReact(host, source)}
        regenerationTargets={host.records
          .filter(
            (record) =>
              record.kind === 'react-ui' &&
              record.designReactConversion?.sourceArtifactId === active.id,
          )
          .map((record) => ({
            id: record.id,
            name: record.name,
            basis: record.designReactConversion!.basis,
            document: record.draft.content as ReactUiDocument,
          }))}
        applyRegeneration={(...args) => applyReactRegeneration(host, ...args)}
        registrations={referenceDesignSettings.registrations}
        settings={referenceDesignSettings}
        publicationReadOnlyReason={
          sharedSession
            ? '共有Hostはnative React公開設定を受け付けません。編集可能なローカル成果物で設定してください。'
            : undefined
        }
        readOnly={readOnly || (host.shared && workspace === 'manga')}
        execute={host.execute}
        select={host.select}
      />
    </div>
  );
}

export const designSurface = hostKind(designKind, { Surface: DesignHost });
