import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { zipSync, strToU8 } from 'fflate';
import { clone, newId } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import {
  DesignSurface,
  isDesign,
  updateElement,
  type DesignSurfaceProps,
  type DesignExtensionContext,
} from '@editor-platform/design';
import {
  designWebTags,
  type DesignWebSettings,
  type DesignWebComponent,
} from '@editor-platform/design/web-contract';
import { Section, CommitInput, EditorExportGuardContext } from '@editor-platform/editor-ui';
import {
  reactComponentKey,
  ReactUiError,
  type ReactUiDiagnostic,
  type RegisteredReactComponent,
  type ReactRuntimeAdapter,
  type JsonValue,
  type ReactUiRevisionCandidate,
  type ReactUiDocument,
} from '@editor-platform/react-ui-core';
import {
  insertDesignReact,
  editDesignReact,
  assignDesignReactSlot,
  assignDesignNativeSlot,
  adoptDesignReactRevision,
  exportDesignReact,
  reviewDesignReceiptRegeneration,
  acceptDesignConversion,
  designReactSourceHash,
  designReactGraphicProblems,
  designReactCanvasOwner,
  convertDesignToReact,
  reviewDesignReactDocumentRegeneration,
  mapDesignElementToReact,
  type DesignReactBundle,
} from '@editor-platform/design-react-core';
import { DesignReactPreview } from './preview';
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
function JsonInput({
  label,
  value,
  onApply,
}: {
  label: string;
  value: unknown;
  onApply(value: unknown): void;
}) {
  const [buffer, setBuffer] = useState<string>(),
    [error, setError] = useState('');
  return (
    <div className="ep-field">
      <label>
        {label}
        <textarea
          aria-label={label}
          rows={5}
          value={buffer ?? JSON.stringify(value, null, 2)}
          onChange={(e) => setBuffer(e.target.value)}
        />
      </label>
      <button
        onClick={() => {
          try {
            onApply(JSON.parse(buffer ?? JSON.stringify(value)));
            setBuffer(undefined);
            setError('');
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Apply {label}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
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
        if (!isDesign(next))
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
        const source = latestContent.current;
        const resolved = await runtime.resolve({
          environment: source.web!.environment.ref,
          components: source.web!.registrations.map((c) => c.ref),
          signal: new AbortController().signal,
        });
        if (!resolved.resolution || resolved.diagnostics.length)
          throw new Error(resolved.diagnostics.map((d) => d.message).join('; '));
        const output = exportDesignReact(source, resolved.resolution, {
          mode: svg ? 'svg' : 'web',
          ...(rootIds ? { rootIds } : {}),
        });
        const dependencies = svg
          ? undefined
          : await runtime.exportDependencies?.({
              environment: source.web!.environment.ref,
              signal: new AbortController().signal,
            });
        if (dependencies?.diagnostics.length)
          throw new Error(dependencies.diagnostics.map((d) => d.message).join('; '));
        const supplied: { path: string; bytes: Uint8Array }[] = [];
        for (const dependency of svg
          ? []
          : source.web!.environment.dependencies.filter(
              (d) => d.kind === 'css' || d.kind === 'asset',
            )) {
          const file = dependencies?.files.find((f) => f.dependencyId === dependency.id);
          if (
            !file ||
            !('path' in dependency) ||
            file.path !== dependency.path ||
            file.hash !== dependency.hash ||
            output.files[file.path]
          )
            throw new Error('Pinned dependency bytes unavailable: ' + dependency.id);
          supplied.push({ path: file.path, bytes: file.bytes });
        }
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
  const extension = useMemo(
    () => ({
      publicationDiagnostics: (candidate: typeof content, componentId: string) => {
        if (!candidate.web) return [];
        const roots = candidate.elements
          .filter((element) => element.componentId === componentId)
          .map((element) => element.id);
        // Validate an unused definition through a temporary native instance, without saving it.
        const definition = candidate.components.find((component) => component.id === componentId)!;
        let counter = 0;
        let id = `publication-validation:${counter}`;
        while (candidate.elements.some((element) => element.id === id))
          id = `publication-validation:${++counter}`;
        return convertDesignToReact(
          roots.length
            ? candidate
            : {
                ...candidate,
                elements: [
                  ...candidate.elements,
                  {
                    id,
                    name: definition.name,
                    type: 'instance',
                    componentId,
                    text: '',
                    fill: '#ffffff',
                    bounds: { x: 0, y: 0, width: definition.width, height: definition.height },
                  },
                ],
              },
          roots.length ? roots : [id],
        ).diagnostics;
      },
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
              <>
                {!element.react && element.type !== 'instance' && (
                  <label>
                    HTML role
                    <select
                      aria-label="HTML role"
                      value={element.web?.tag ?? ''}
                      onChange={(e) =>
                        apply(
                          updateElement(element.id, {
                            web: {
                              ...element.web,
                              tag: e.target.value as (typeof designWebTags)[number],
                            },
                          }),
                        )
                      }
                    >
                      <option value="">Choose explicit role</option>
                      {designWebTags.map((tag) => (
                        <option key={tag}>{tag}</option>
                      ))}
                    </select>
                  </label>
                )}
                {!element.react && element.type !== 'instance' && (
                  <label>
                    Map selected native element to React
                    <select
                      aria-label="Map selected native element to React"
                      disabled={surface.readOnly}
                      value=""
                      onChange={(event) => {
                        const candidate = registrations.find(
                          (c) => reactComponentKey(c.ref) === event.target.value,
                        );
                        if (candidate) apply(mapDesignElementToReact(element.id, candidate));
                      }}
                    >
                      <option value="">Choose reviewed registration</option>
                      {registrations.map((c) => (
                        <option key={reactComponentKey(c.ref)} value={reactComponentKey(c.ref)}>
                          {c.name} @{c.ref.version}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <JsonInput
                  key={element.id + 'layout'}
                  label="Web responsive layout"
                  value={element.web?.layout ?? { base: {}, breakpoints: {} }}
                  onApply={(value) =>
                    apply(
                      updateElement(element.id, {
                        web: { ...element.web, layout: value as never },
                      }),
                    )
                  }
                />
                {element.web?.tag === 'a' && (
                  <label>
                    Link page
                    <select
                      aria-label="Link page"
                      value={element.web.linkPageId ?? ''}
                      onChange={(e) =>
                        apply(
                          updateElement(element.id, {
                            web: { ...element.web, linkPageId: e.target.value },
                          }),
                        )
                      }
                    >
                      <option value="">Choose page</option>
                      {content.web.pages.map((p) => (
                        <option value={p.frameId} key={p.frameId}>
                          {p.symbol}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {element.react &&
                  (() => {
                    const c = content.web.registrations.find(
                      (c) =>
                        reactComponentKey(c.ref) === reactComponentKey(element.react!.component),
                    );
                    return (
                      <>
                        <p>
                          External React · {c?.name ?? element.react.component.componentId} @
                          {element.react.component.version}
                        </p>
                        {Object.entries(c?.props ?? {}).map(([key, field]) =>
                          field.schema.type === 'object' || field.schema.type === 'array' ? (
                            <JsonInput
                              key={element.id + key}
                              label={`React prop ${key}`}
                              value={element.react!.props[key] ?? field.default ?? null}
                              onApply={(value) =>
                                apply(
                                  editDesignReact(element.id, {
                                    prop: key,
                                    value: value as JsonValue,
                                  }),
                                )
                              }
                            />
                          ) : field.schema.type === 'enum' ? (
                            <label key={key}>
                              {key}
                              <select
                                aria-label={`React prop ${key}`}
                                value={String(element.react!.props[key] ?? field.default ?? '')}
                                onChange={(e) =>
                                  apply(
                                    editDesignReact(element.id, {
                                      prop: key,
                                      value: e.target.value,
                                    }),
                                  )
                                }
                              >
                                {field.schema.type === 'enum' &&
                                  field.schema.values.map((v) => <option key={v}>{v}</option>)}
                              </select>
                            </label>
                          ) : (
                            <CommitInput
                              key={key}
                              label={`React prop ${key}`}
                              value={String(element.react!.props[key] ?? field.default ?? '')}
                              onCommit={(v) =>
                                apply(
                                  editDesignReact(element.id, {
                                    prop: key,
                                    value:
                                      field.schema.type === 'number'
                                        ? Number(v)
                                        : field.schema.type === 'boolean'
                                          ? v === 'true'
                                          : v,
                                  }),
                                )
                              }
                            />
                          ),
                        )}
                        <JsonInput
                          key={element.id + 'bindings'}
                          label="React bindings"
                          value={element.react.bindings}
                          onApply={(value) =>
                            apply(
                              updateElement(element.id, {
                                react: {
                                  ...element.react!,
                                  bindings: value as never,
                                  props: Object.fromEntries(
                                    Object.entries(element.react!.props).filter(
                                      ([key]) => !Object.hasOwn(value as object, key),
                                    ),
                                  ),
                                },
                              }),
                            )
                          }
                        />
                        {Object.keys(c?.slots ?? {}).map((slot) => (
                          <JsonInput
                            key={slot + element.id}
                            label={`React slot ${slot}`}
                            value={element.react!.slots[slot] ?? []}
                            onApply={(value) =>
                              apply(assignDesignReactSlot(element.id, slot, value as string[]))
                            }
                          />
                        ))}
                        {revisions
                          .filter(
                            (r) =>
                              r.component.ref.componentId ===
                                element.react!.component.componentId &&
                              r.component.ref.version !== element.react!.component.version,
                          )
                          .map((r) => (
                            <button
                              key={r.component.ref.version}
                              onClick={() =>
                                apply(
                                  adoptDesignReactRevision(
                                    element.id,
                                    r.component,
                                    r.propMap,
                                    r.slotMap,
                                  ),
                                )
                              }
                            >
                              Adopt React {r.component.ref.componentId} @{r.component.ref.version}
                            </button>
                          ))}
                      </>
                    );
                  })()}
                {element.type === 'instance' &&
                  Object.keys(
                    content.components.find((c) => c.id === element.componentId)?.web?.slots ?? {},
                  ).map((slot) => (
                    <JsonInput
                      key={element.id + slot}
                      label={`Native React slot ${slot}`}
                      value={element.webSlots?.[slot] ?? []}
                      onApply={(value) =>
                        apply(assignDesignNativeSlot(element.id, slot, value as string[]))
                      }
                    />
                  ))}
                {element.type === 'instance' && (
                  <JsonInput
                    key={element.id + 'props'}
                    label="Native React public props"
                    value={element.webProps ?? {}}
                    onApply={(value) =>
                      apply(
                        updateElement(element.id, { webProps: value as Record<string, JsonValue> }),
                      )
                    }
                  />
                )}
                {!element.react && (
                  <JsonInput
                    key={element.id + 'bindings'}
                    label="Native Web bindings"
                    value={element.web?.bindings ?? {}}
                    onApply={(value) =>
                      apply(
                        updateElement(element.id, {
                          web: { ...element.web, bindings: value as never },
                        }),
                      )
                    }
                  />
                )}
                {element.type === 'frame' && (
                  <CommitInput
                    label="React page route"
                    value={content.web.pages.find((p) => p.frameId === element.id)?.path ?? ''}
                    onCommit={(path) =>
                      apply(
                        command('design.web.route', 'Set explicit React page', (d) => ({
                          ...d,
                          web: {
                            ...d.web!,
                            pages: [
                              ...d.web!.pages.filter((p) => p.frameId !== element.id),
                              {
                                frameId: element.id,
                                symbol:
                                  content.web!.pages.find((p) => p.frameId === element.id)
                                    ?.symbol ?? 'Page' + (content.web!.pages.length + 1),
                                path,
                              },
                            ],
                          },
                        })),
                      )
                    }
                  />
                )}
                {element.componentId && (
                  <JsonInput
                    label="Native React component contract"
                    value={
                      content.components.find((c) => c.id === element.componentId)?.web ?? {
                        symbol: 'ProductCard',
                        version: '1.0.0',
                        props: {},
                        variants: {},
                      }
                    }
                    onApply={(value) =>
                      apply(
                        command('design.web.component', 'Publish native React contract', (d) => ({
                          ...d,
                          components: d.components.map((c) =>
                            c.id === element.componentId
                              ? { ...c, web: value as DesignWebComponent }
                              : c,
                          ),
                        })),
                      )
                    }
                  />
                )}
                <button onClick={() => setPreview(element.id)}>
                  Preview selected Design as React
                </button>
              </>
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
              <>
                <label>
                  React UI regeneration target
                  <select
                    aria-label="React UI regeneration target"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                  >
                    <option value="">Choose a retained conversion</option>
                    {regenerationTargets.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={surface.readOnly || !target}
                  onClick={() => {
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
                  }}
                >
                  Review React UI regeneration
                </button>
              </>
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
        extension={extension}
        publicationRequest={publicationTarget}
        focusRequest={diagnosticTarget}
        onPublicationClosed={() => setPublicationTarget(undefined)}
      />
      {error && (
        <div role="alert" className="surface-error">
          {error}
          {exportDiagnostics.map((diagnostic, index) => {
            const element = content.elements.find((element) => element.id === diagnostic.path);
            const component = content.components.find(
              (component) =>
                component.id === element?.componentId ||
                diagnostic.path === component.id ||
                diagnostic.path.startsWith(component.id + '/'),
            );
            return (
              <div key={index}>
                {diagnostic.code}: {diagnostic.message}
                {element && !component && (
                  <button
                    onClick={() => {
                      setDiagnosticTarget({ id: element.id });
                      setError('');
                    }}
                  >
                    Edit HTML semantics {element.name}
                  </button>
                )}
                {component && (
                  <button
                    onClick={() => {
                      setPublicationTarget(component.id);
                      setError('');
                    }}
                  >
                    Configure React publication {component.name}
                  </button>
                )}
              </div>
            );
          })}
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      {preview && (
        <div
          role="dialog"
          aria-label="Design React preview"
          className="design-react-dialog"
          style={{
            position: 'fixed',
            inset: 20,
            zIndex: 1000,
            background: 'white',
            padding: 16,
            overflow: 'auto',
          }}
        >
          <button onClick={() => setPreview(undefined)}>Close preview</button>
          <label>
            Width
            <select
              aria-label="Design React preview width"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            >
              {[390, 1024, 1400].map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </label>
          <button onClick={() => setMode(mode === 'edit' ? 'interact' : 'edit')}>
            {mode === 'edit' ? 'Interact with React' : 'Edit preview'}
          </button>
          <DesignReactPreview
            content={content}
            rootIds={[preview]}
            runtime={runtime}
            width={width}
            height={700}
            mode={mode}
          />
        </div>
      )}
      {review && (
        <div
          role="dialog"
          aria-label="Review Design React export"
          style={{
            position: 'fixed',
            inset: '10%',
            zIndex: 1001,
            background: 'white',
            padding: 24,
            overflow: 'auto',
          }}
        >
          <h2>Review Design React export</h2>
          <p>
            Source {review.sourceHash} · {review.ownership}
          </p>
          <pre>{JSON.stringify(changes?.changes ?? Object.keys(review.files), null, 2)}</pre>
          {review.diagnostics.map((d) => (
            <p key={d.path + d.code}>{d.message}</p>
          ))}
          <button
            disabled={surface.readOnly}
            onClick={() => {
              try {
                guard?.();
                checkedExecute(acceptDesignConversion(review));
                setError('');
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Accept reviewed conversion
          </button>
          <button
            disabled={
              content.web?.accepted?.fingerprint !== review.fingerprint ||
              content.web?.accepted?.sourceHash !== review.sourceHash
            }
            onClick={() => {
              try {
                guard?.();
                if (review.sourceHash !== designReactSourceHash(content))
                  throw new Error(
                    'Native source changed; review the new conversion before downloading',
                  );
                const files: Record<string, Uint8Array> = Object.fromEntries(
                  Object.entries(review.files).map(([path, value]) => [path, strToU8(value)]),
                );
                for (const file of material) files[file.path] = file.bytes;
                const bytes = zipSync(files);
                const url = URL.createObjectURL(
                  new Blob([bytes as BlobPart], { type: 'application/zip' }),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = 'design-react.zip';
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Download React bundle
          </button>
          <button onClick={() => setReview(undefined)}>Close export review</button>
        </div>
      )}
      {regeneration && (
        <div
          role="dialog"
          aria-label="Review React UI regeneration"
          style={{
            position: 'fixed',
            inset: '10%',
            zIndex: 1001,
            background: 'white',
            padding: 24,
            overflow: 'auto',
          }}
        >
          <h2>Review React UI regeneration</h2>
          <p>
            Source {regeneration.sourceHash} · Target {regeneration.plan.target}
          </p>
          <p>
            Independent React UI edits are retained. Shared changes require the target's authority
            session.
          </p>
          <pre>
            {JSON.stringify(
              regeneration.plan.conflicts.length
                ? regeneration.plan.conflicts
                : regeneration.plan.document,
              null,
              2,
            )}
          </pre>
          <button
            disabled={surface.readOnly || regeneration.plan.conflicts.length > 0}
            onClick={() => {
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
          >
            Accept React UI regeneration
          </button>
          <button onClick={() => setRegeneration(undefined)}>Close regeneration review</button>
        </div>
      )}
    </>
  );
}
