import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { clone, newId } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import {
  DesignSurface,
  isDesignWithPaths,
  type DesignSurfaceProps,
  type DesignExtensionContext,
} from '@editor-platform/design';
import { type DesignWebSettings } from '@editor-platform/design/web-contract';
import { Section, EditorExportGuardContext } from '@editor-platform/editor-ui';
import {
  reactComponentKey,
  ReactUiError,
  type ReactUiDiagnostic,
  type RegisteredReactComponent,
  type ReactRuntimeAdapter,
  type ReactUiRevisionCandidate,
  type ReactUiDocument,
} from '@editor-platform/react-ui-core';
import {
  insertDesignReact,
  reviewDesignReceiptRegeneration,
  acceptDesignConversion,
  designReactSourceHash,
  designReactGraphicProblems,
  designReactCanvasOwner,
  convertDesignToReact,
  reviewDesignReactDocumentRegeneration,
  type DesignReactBundle,
} from '@editor-platform/design-react-core';
import { DesignReactPreview } from './preview';
import { JsonInput } from './json-input';
import { designReactPublicationDiagnostics, prepareDesignReactBundle } from './export-material';
import { ReactElementInspector, RegenerationControls } from './inspector';
import {
  ExportErrorAlert,
  ExportReviewDialog,
  PreviewDialog,
  RegenerationDialog,
  downloadDesignReactBundle,
} from './dialogs';
export { DesignReactPreview } from './preview';
interface Props extends DesignSurfaceProps {
  runtime: ReactRuntimeAdapter;
  registrations: RegisteredReactComponent[];
  settings: DesignWebSettings;
  revisions?: (Omit<ReactUiRevisionCandidate, 'nodeIds'> & {
    component: RegisteredReactComponent;
  })[];
  registerGenerated?(content: import('@editor-platform/design/model').DesignContent): void;
  regenerationTargets?: {
    id: string;
    name: string;
    basis: ReactUiDocument;
    document: ReactUiDocument;
  }[];
  applyRegeneration?(
    id: string,
    sourceHash: string,
    review: ReturnType<typeof reviewDesignReactDocumentRegeneration>,
  ): void;
}
export function DesignReactSurface({
  content,
  runtime,
  registrations,
  settings,
  revisions = [],
  registerGenerated,
  regenerationTargets = [],
  applyRegeneration,
  ...surface
}: Props) {
  const guard = useContext(EditorExportGuardContext);
  const latestContent = useRef(content);
  latestContent.current = content;
  const [error, setError] = useState(''),
    [preview, setPreview] = useState<string>(),
    [width, setWidth] = useState(390),
    [mode, setMode] = useState<'edit' | 'interact'>('edit');
  const [exportDiagnostics, setExportDiagnostics] = useState<ReactUiDiagnostic[]>([]);
  const [diagnosticTarget, setDiagnosticTarget] = useState<{ id: string }>();
  const [publicationTarget, setPublicationTarget] = useState<string>();
  const [review, setReview] = useState<DesignReactBundle>();
  const [target, setTarget] = useState('');
  const [regeneration, setRegeneration] = useState<{
    id: string;
    sourceHash: string;
    plan: ReturnType<typeof reviewDesignReactDocumentRegeneration>;
  }>();
  const checkedExecute: typeof surface.execute = (cmd) =>
    surface.execute({
      ...cmd,
      apply: (d) => {
        const next = cmd.apply(d);
        if (!isDesignWithPaths(next))
          throw new Error('Invalid native Web metadata; correct JSON before applying');
        return next;
      },
    });
  const [svg, setSvg] = useState(false);
  const [material, setMaterial] = useState<{ path: string; bytes: Uint8Array }[]>([]);
  const previous = content.web?.accepted;
  const prepareExport = useCallback(
    async (rootIds?: string[]) => {
      try {
        guard?.();
        const { output, supplied } = await prepareDesignReactBundle(
          latestContent.current,
          runtime,
          svg,
          rootIds,
        );
        setMaterial(supplied);
        setReview(output);
        setError('');
        setExportDiagnostics([]);
      } catch (e) {
        setError(String(e));
        setExportDiagnostics(e instanceof ReactUiError ? e.diagnostics : []);
      }
    },
    [guard, content, runtime, svg],
  );
  const reviewRegeneration = () => {
    try {
      guard?.();
      const candidate = regenerationTargets.find((item) => item.id === target);
      if (!candidate) throw new Error('Conversion target unavailable');
      const next = convertDesignToReact(content);
      if (next.diagnostics.length)
        throw new Error(next.diagnostics.map((d) => d.message).join('; '));
      setRegeneration({
        id: target,
        sourceHash: next.sourceHash,
        plan: reviewDesignReactDocumentRegeneration(
          candidate.basis,
          candidate.document,
          next.document,
        ),
      });
    } catch (e) {
      setError(String(e));
    }
  };
  const extension = useMemo(
    () => ({
      publicationDiagnostics: designReactPublicationDiagnostics,
      canvasOwner: (element: import('@editor-platform/design/model').DesignElement) =>
        designReactCanvasOwner(content, element.id),
      beforeGraphicExport: (ids: string[]) => {
        const unsupported = designReactGraphicProblems(content, ids);
        if (unsupported.length)
          throw new Error(
            'SVG/PNG cannot preserve external React content (' +
              unsupported.join(', ') +
              '). Review React Web output instead.',
          );
      },
      library: ({ element, apply, choose }: DesignExtensionContext) => (
        <Section title="React components">
          {!content.web ? (
            <button
              disabled={surface.readOnly}
              onClick={() =>
                apply(
                  command('design.web.configure', 'Enable React Web', (d) => ({
                    ...d,
                    web: clone(settings),
                  })),
                )
              }
            >
              Enable React Web
            </button>
          ) : (
            registrations.map((c) => (
              <button
                key={reactComponentKey(c.ref)}
                disabled={surface.readOnly}
                onClick={() => {
                  const id = newId('react');
                  const parent =
                    element && ['frame', 'group', 'react'].includes(element.type)
                      ? element
                      : undefined;
                  const slot = parent?.react
                    ? Object.keys(
                        content.web!.registrations.find(
                          (c) =>
                            reactComponentKey(c.ref) === reactComponentKey(parent.react!.component),
                        )?.slots ?? {},
                      )[0]
                    : undefined;
                  apply(insertDesignReact(c, id, parent?.id, slot));
                  choose([id]);
                }}
              >
                Insert React {c.name}
              </button>
            ))
          )}
        </Section>
      ),
      inspector: ({ element, apply }: DesignExtensionContext) =>
        content.web && (
          <Section title="React Web settings">
            {element && (
              <ReactElementInspector
                content={{ ...content, web: content.web }}
                element={element}
                registrations={registrations}
                revisions={revisions}
                readOnly={surface.readOnly}
                apply={apply}
                setPreview={setPreview}
              />
            )}
            <JsonInput
              label="React page settings"
              value={{ ...content.web, accepted: undefined, publications: undefined }}
              onApply={(value) =>
                apply(
                  command('design.web.configure', 'Edit Web inputs/routes', (d) => ({
                    ...d,
                    web: {
                      ...(value as DesignWebSettings),
                      ...(d.web?.accepted ? { accepted: d.web.accepted } : {}),
                      ...(d.web?.publications ? { publications: d.web.publications } : {}),
                    },
                  })),
                )
              }
            />
            {registerGenerated && (
              <button
                disabled={surface.readOnly}
                onClick={() => {
                  try {
                    guard?.();
                    registerGenerated(latestContent.current);
                    setError('');
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Register native components for React UI
              </button>
            )}
            {applyRegeneration && regenerationTargets.length > 0 && (
              <RegenerationControls
                targets={regenerationTargets}
                target={target}
                setTarget={setTarget}
                readOnly={surface.readOnly}
                onReview={reviewRegeneration}
              />
            )}
          </Section>
        ),
      toolbar: ({ selected }: DesignExtensionContext) =>
        content.web && (
          <>
            <button onClick={() => void prepareExport()}>Review React export</button>
            <button disabled={!selected.length} onClick={() => void prepareExport(selected)}>
              Review selected React export
            </button>
            <label>
              <input type="checkbox" checked={svg} onChange={(e) => setSvg(e.target.checked)} />
              React SVG graphic
            </label>
          </>
        ),
      render: (
        element: import('@editor-platform/design/model').DesignElement,
        bounds: import('@editor-platform/editor-core').Bounds,
      ) => {
        if (
          element.type !== 'react' &&
          !(
            element.type === 'instance' &&
            content.components.some((c) => c.id === element.componentId && c.web)
          )
        )
          return undefined;
        return (
          <foreignObject x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height}>
            <DesignReactPreview
              content={content}
              rootIds={[element.id]}
              runtime={runtime}
              width={bounds.width}
              height={bounds.height}
            />
          </foreignObject>
        );
      },
    }),
    [
      content,
      runtime,
      registrations,
      settings,
      surface.readOnly,
      svg,
      revisions,
      registerGenerated,
      regenerationTargets,
      applyRegeneration,
      target,
      guard,
      prepareExport,
    ],
  );
  const changes =
    review && previous ? reviewDesignReceiptRegeneration(previous, review) : undefined;
  return (
    <>
      <DesignSurface
        {...surface}
        execute={checkedExecute}
        content={content}
        extension={
          content.schemaVersion === 3
            ? { beforeGraphicExport: extension.beforeGraphicExport }
            : extension
        }
        publicationRequest={publicationTarget}
        focusRequest={diagnosticTarget}
        onPublicationClosed={() => setPublicationTarget(undefined)}
      />
      {error && (
        <ExportErrorAlert
          content={content}
          error={error}
          diagnostics={exportDiagnostics}
          dismiss={() => setError('')}
          focusElement={(id) => {
            setDiagnosticTarget({ id });
            setError('');
          }}
          configurePublication={(id) => {
            setPublicationTarget(id);
            setError('');
          }}
        />
      )}
      {preview && (
        <PreviewDialog
          content={content}
          rootId={preview}
          runtime={runtime}
          width={width}
          setWidth={setWidth}
          mode={mode}
          setMode={setMode}
          close={() => setPreview(undefined)}
        />
      )}
      {review && (
        <ExportReviewDialog
          content={content}
          review={review}
          changes={changes}
          readOnly={surface.readOnly}
          accept={() => {
            try {
              guard?.();
              checkedExecute(acceptDesignConversion(review));
              setError('');
            } catch (e) {
              setError(String(e));
            }
          }}
          download={() => {
            try {
              guard?.();
              if (review.sourceHash !== designReactSourceHash(content))
                throw new Error(
                  'Native source changed; review the new conversion before downloading',
                );
              downloadDesignReactBundle(review, material);
            } catch (e) {
              setError(String(e));
            }
          }}
          close={() => setReview(undefined)}
        />
      )}
      {regeneration && (
        <RegenerationDialog
          regeneration={regeneration}
          readOnly={surface.readOnly}
          accept={() => {
            try {
              guard?.();
              if (regeneration.sourceHash !== designReactSourceHash(content))
                throw new Error('Native source changed after regeneration review');
              applyRegeneration?.(regeneration.id, regeneration.sourceHash, regeneration.plan);
              setRegeneration(undefined);
            } catch (e) {
              setError(String(e));
            }
          }}
          close={() => setRegeneration(undefined)}
        />
      )}
    </>
  );
}
