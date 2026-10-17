import { EditorInputsContext } from '@editor-platform/editor-ui';
import {
  assertReferenceItems,
  referenceExportManifest,
} from '@editor-platform/artifact-references';
import {
  ReferenceTools,
  ReferenceWarnings,
  ReferenceInspector,
  useReferenceItems,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { memo, useContext, useMemo, useImperativeHandle, type Ref, type ReactNode } from 'react';
import { EditorExportGuardContext } from '@editor-platform/editor-ui';
import { ComponentPublicationDialog } from './component-publication-ui';
import { DesignPrototypeSurface, type DesignPrototypeSurfaceProps } from './prototype-view';
import { DesignInteractionSettings, DesignPrototypeSettings } from './prototype-settings';
import { setDesignInteractions } from './prototype';
import { useEffect, useRef, useState } from 'react';
import { Frame, Component, Scan, Plus, Download } from 'lucide-react';
import {
  clone,
  newId,
  canonicalJson,
  isDeepFrozen,
  deepFreeze,
} from '@editor-platform/artifact-core';
import {
  command,
  descendantIds,
  unionBounds,
  type Bounds,
  type Drawing,
  type EditorCommand,
  type Region,
  type ShapeKind,
} from '@editor-platform/editor-core';
import {
  EditorLayout,
  IconButton,
  Menu,
  Section,
  CommitInput,
  Dialog,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import {
  CanvasStage,
  CanvasControls,
  DrawingView,
  initialCanvasView,
  InsertTools,
  ArrangeMenu,
  EditMenu,
  VisualInspector,
  LayerNavigator,
  exportPages,
  readImage,
  type CanvasView,
  type CanvasTarget,
} from '@editor-platform/canvas-ui';
import {
  alignElements,
  applyFramePreset,
  appearance,
  arrangeDesign,
  createComponent,
  createDesign,
  designDrawings,
  designPreview,
  designPaintOrder,
  detachInstance,
  duplicateElements,
  exportDesignSvg,
  insertInstance,
  layoutDesign,
  makeDesignElement,
  overrideInstance,
  patchDesign,
  reparentElement,
  resetInstance,
  transformElements,
  updateComponent,
  updateComponentPart,
  type DesignContent,
  type DesignElement,
  type DesignElementType,
} from './model';
import { designWebTagsFor, type DesignWebTag } from './web-contract';
import { createDesignRenderCache, designRenderSnapshot } from './render-cache';
import { designPaintBounds } from './paint-bounds';
const DesignDrawings = memo(function DesignDrawings({
  drawings,
  textParts = [],
}: {
  drawings: Drawing[];
  textParts?: CanvasTarget['textParts'];
}) {
  return (
    <>
      {drawings.map((drawing, index) => (
        <g
          key={`${drawing.id}-${index}`}
          data-canvas-text-target={textParts.find((p) => p.drawingId === drawing.id)?.id}
        >
          <DrawingView drawing={drawing} />
        </g>
      ))}
    </>
  );
});

export interface DesignExtensionContext {
  selected: string[];
  element?: DesignElement;
  apply(command: EditorCommand<DesignContent>): void;
  choose(ids: string[]): void;
}
export interface DesignSurfaceExtension {
  publicationDiagnostics?(
    candidate: DesignContent,
    componentId: string,
  ): { code: string; path: string; message: string }[];
  library?(context: DesignExtensionContext): ReactNode;
  inspector?(context: DesignExtensionContext): ReactNode;
  toolbar?(context: DesignExtensionContext): ReactNode;
  render?(element: DesignElement, bounds: Bounds): ReactNode;
  beforeGraphicExport?(ids: string[]): void;
  /** An opaque Host element paints its slot subtree once; the native tree stays editable. */
  canvasOwner?(element: DesignElement): string | undefined;
}
export interface DesignSurfaceProps extends ReferenceSurfaceProps {
  prototype?: Omit<DesignPrototypeSurfaceProps, 'content' | 'onClose'>;
  extension?: DesignSurfaceExtension;
  content: DesignContent;
  execute: (c: EditorCommand<DesignContent>) => void | boolean;
  publicationRequest?: string;
  focusRequest?: { id: string };
  publicationReadOnlyReason?: string;
  onPublicationClosed?: () => void;
  select: (ids: string[], region?: Region) => void;
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
}
export function DesignSurface(props: DesignSurfaceProps) {
  // A Host render is a revision boundary even if it mutates the same input object.
  // Local camera/panel state lives below this boundary and retains that snapshot.
  const renderContent = isDeepFrozen(props.content)
    ? props.content
    : deepFreeze(clone(props.content));
  return <DesignSurfaceEditor {...props} renderContent={renderContent} />;
}
function DesignSurfaceEditor({
  references,
  focusReferenceId,
  content,
  execute,
  select,
  readOnly = false,
  layout,
  extension,
  publicationRequest,
  focusRequest,
  publicationReadOnlyReason,
  onPublicationClosed,
  prototype,
  renderContent,
}: DesignSurfaceProps & { renderContent: DesignContent }) {
  const prototypeControl = useRef<{ open(): void }>(null);
  const projectedElements = useReferenceItems(content.elements, references);
  const projectedById = new Map(projectedElements.map((e) => [e.id, e]));
  const guardExport = useContext(EditorExportGuardContext);
  const inputs = useContext(EditorInputsContext);
  const [publication, setPublication] = useState<string>();
  useEffect(() => {
    if (publicationRequest) setPublication(publicationRequest);
  }, [publicationRequest]);
  const renderCache = useMemo(createDesignRenderCache, []);
  const project = useMemo(
    () => designRenderSnapshot(renderContent, renderCache),
    [renderContent, renderCache],
  );
  const elements = new Map(content.elements.map((e) => [e.id, e]));
  const scopedTexts = useMemo(() => {
    const map = new Map<
      string,
      { rootId: string; partId: string; target: NonNullable<CanvasTarget['textParts']>[number] }
    >();
    for (const root of content.elements.filter((e) => e.type === 'instance')) {
      const component = content.components.find((c) => c.id === root.componentId);
      const drawings = project(root);
      for (const part of component?.elements ?? [])
        if (['text', 'shape', 'rectangle'].includes(part.type)) {
          const drawing = drawings.find((d) => d.id === `${root.id}-${part.id}`);
          if (!drawing || drawing.hidden) continue;
          const id = `${root.id}/${part.id}`;
          map.set(id, {
            rootId: root.id,
            partId: part.id,
            target: {
              id,
              drawingId: drawing.id,
              label: `Component text ${part.name}`,
              bounds: drawing.bounds,
              rotation: drawing.rotation,
              text: drawing.text ?? '',
              typography: drawing.typography,
              runs: drawing.runs,
              textDrawing: drawing,
            },
          });
        }
    }
    return map;
  }, [content, project]);
  const [selected, setSelected] = useState<string[]>([]),
    [view, setView] = useState<CanvasView>(initialCanvasView),
    [error, setError] = useState(''),
    [reference, setReference] = useState('selection'),
    [tab, setTab] = useState('layers'),
    [definition, setDefinition] = useState(false),
    [padding, setPadding] = useState(20),
    [transparent, setTransparent] = useState(true),
    [scale, setScale] = useState(1);
  const [preset, setPreset] = useState<{ id: string; width: number; height: number }>();
  const clipboard = useRef<DesignElement[]>([]),
    viewport = useRef<HTMLDivElement>(null);
  const ids = selected.filter((id) => content.elements.some((e) => e.id === id)),
    chosen = content.elements.filter((e) => ids.includes(e.id)),
    element = chosen.length === 1 ? chosen[0] : undefined;
  useEffect(() => {
    if (focusReferenceId) setSelected([focusReferenceId]);
  }, [focusReferenceId]);
  const exportState = useRef({ content, ids, padding, transparent, scale, extension, references });
  exportState.current = { content, ids, padding, transparent, scale, extension, references };
  const apply = (cmd: EditorCommand<DesignContent>) => {
    if (readOnly) return false;
    const checked: EditorCommand<DesignContent> = {
      ...cmd,
      apply(current) {
        const next = cmd.apply(current);
        assertReferenceItems(next.elements);
        return next;
      },
    };
    try {
      if (!checked.readonlyInput) checked.apply(content);
      if (execute(checked) === false) return false;
      setError('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const choose = (ids: string[]) => {
    setSelected(ids);
    select(ids);
    setDefinition(false);
  };
  useEffect(() => {
    if (focusRequest && content.elements.some((element) => element.id === focusRequest.id)) {
      setSelected([focusRequest.id]);
      select([focusRequest.id]);
      setDefinition(false);
    }
  }, [focusRequest, select]);
  function add(type: DesignElementType, patch: Partial<DesignElement> = {}) {
    const parent = element?.type === 'frame' ? element : undefined;
    const rect = viewport.current?.getBoundingClientRect();
    const center = {
      x: rect ? (rect.width / 2 - view.pan.x) / view.zoom : 450,
      y: rect ? (rect.height / 2 - view.pan.y) / view.zoom : 280,
    };
    const item = { ...makeDesignElement(type, content.elements.length), ...patch };
    if (!patch.bounds)
      item.bounds = {
        ...item.bounds,
        x: parent ? parent.bounds.x + 24 : center.x - item.bounds.width / 2,
        y: parent ? parent.bounds.y + 24 : center.y - item.bounds.height / 2,
      };
    if (parent) item.parentId = parent.id;
    apply(
      command('design.insert', `Insert ${type}`, (d) =>
        layoutDesign({ ...d, elements: [...d.elements, item] }),
      ),
    );
    choose([item.id]);
  }
  async function image(file: File) {
    try {
      add('image', { src: await readImage(file), alt: file.name });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function action(a: string, value?: number) {
    if (a === 'copy' || a === 'cut') {
      const all = descendantIds(content.elements, ids);
      clipboard.current = clone(content.elements.filter((e) => all.has(e.id)));
      if (a === 'cut') apply(arrangeDesign(ids, 'delete'));
      return;
    }
    if (a === 'paste') {
      if (!clipboard.current.length) {
        setError('Copy elements in this editor first');
        return;
      }
      const temporary = { ...createDesign(), elements: clipboard.current };
      const duplicates = duplicateElements(clipboard.current.map((e) => e.id))
        .apply(temporary)
        .elements.slice(clipboard.current.length);
      apply(
        command('design.paste', 'Paste elements', (d) => ({
          ...d,
          elements: [...d.elements, ...duplicates],
        })),
      );
      choose(duplicates.filter((e) => !e.parentId).map((e) => e.id));
      return;
    }
    apply(arrangeDesign(ids, a, value));
  }
  function geometry(patch: Partial<Bounds>) {
    const box = unionBounds(chosen.map((e) => e.bounds));
    apply(
      transformElements(ids, {
        dx: patch.x === undefined ? 0 : patch.x - box.x,
        dy: patch.y === undefined ? 0 : patch.y - box.y,
        dw: patch.width === undefined ? 0 : patch.width - box.width,
        dh: patch.height === undefined ? 0 : patch.height - box.height,
      }),
    );
  }
  function fit(nextIds?: string[]) {
    const visibleElements = content.elements.filter((e) => !extension?.canvasOwner?.(e));
    const roots = nextIds?.map((id) => {
      const element = content.elements.find((e) => e.id === id);
      return (element && extension?.canvasOwner?.(element)) || id;
    });
    const all = roots?.length
      ? descendantIds(visibleElements, roots)
      : new Set(visibleElements.map((e) => e.id));
    const box = unionBounds(
      visibleElements.filter((e) => all.has(e.id) && !e.hidden).map((e) => e.bounds),
    );
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = Math.min((rect.width - 60) / box.width, (rect.height - 60) / box.height);
    setView({
      ...view,
      fit: !nextIds?.length,
      zoom: Math.max(0.001, Math.min(8, zoom)),
      pan: {
        x: (rect.width - box.width * zoom) / 2 - box.x * zoom,
        y: (rect.height - box.height * zoom) / 2 - box.y * zoom,
      },
    });
  }
  async function output(format: 'svg' | 'png', scope: string) {
    try {
      guardExport?.();
      const initial = exportState.current;
      let content = initial.content;
      const { ids, padding, transparent, scale, extension } = initial;
      const frames = content.elements.filter((e) => e.type === 'frame');
      const groups =
        scope === 'frames'
          ? frames.map((e) => [e.id])
          : scope === 'selection'
            ? [ids]
            : [content.elements.map((e) => e.id)];
      if (scope === 'selection' && !ids.length) throw new Error('Select elements to export');
      const included = descendantIds(content.elements, groups.flat());
      const visible = new Set(
        designPaintOrder(content)
          .filter((e) => !e.hidden)
          .map((e) => e.id),
      );
      let exported = content.elements.filter((e) => included.has(e.id) && visible.has(e.id));
      if (exported.some((e) => e.reference)) {
        if (!references) throw new Error('参照付きの出力には参照接続が必要です。');
        exported = await references.capture(exported);
        if (exportState.current.references !== references)
          throw new Error('取得中に参照接続が変わりました。再実行してください。');
        if (
          exportState.current.content !== content ||
          inputs?.getSnapshot().dirty ||
          inputs?.getSnapshot().composing
        )
          throw new Error('取得中に入力が変わりました。再実行してください。');
        const captured = new Map(exported.map((e) => [e.id, e]));
        content = { ...content, elements: content.elements.map((e) => captured.get(e.id) ?? e) };
      }
      const pages = groups.map((group) => {
        extension?.beforeGraphicExport?.(group);
        const all = descendantIds(content.elements, group),
          box = unionBounds(
            content.elements.filter((e) => all.has(e.id) && !e.hidden).map((e) => e.bounds),
          );
        return {
          name:
            group.length === 1 ? content.elements.find((e) => e.id === group[0])!.name : 'design',
          svg: exportDesignSvg(content, group, {
            padding,
            background: transparent ? undefined : '#ffffff',
          }),
          width: box.width + padding * 2,
          height: box.height + padding * 2,
        };
      });
      await exportPages(pages, format, scale, 'design', referenceExportManifest(exported));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const component = element?.componentId
    ? content.components.find((c) => c.id === element.componentId)
    : undefined;
  const extensionContext = { selected: ids, element, apply, choose };
  const canvasOwners = new Map(content.elements.map((e) => [e.id, extension?.canvasOwner?.(e)]));
  const canvasSelection = [...new Set(ids.map((id) => canvasOwners.get(id) ?? id))];
  const inspector = (
    <>
      <ReferenceInspector
        item={element}
        resolver={references}
        readOnly={readOnly}
        patch={(patch) =>
          apply(
            patchDesign(ids, {
              ...patch,
              imageFit: (patch.reference ?? element?.reference)?.fit === 'cover' ? 'fill' : 'fit',
            }),
          )
        }
      />
      <fieldset disabled={readOnly} className="inspector-fields">
        <ReferenceWarnings items={content.elements} resolver={references} />
        <DesignPrototypeSettings content={content} element={element} apply={apply} />
        <VisualInspector
          items={chosen.map((e) => {
            const first = designDrawings(content, e)[0];
            return { ...first, id: e.id, bounds: e.bounds, text: appearance(content, e).text };
          })}
          onPatch={(patch) => apply(patchDesign(ids, patch))}
          onGeometry={geometry}
          onReplace={(file) => {
            void readImage(file)
              .then((src) => apply(patchDesign(ids, { src, reference: undefined })))
              .catch((e) => setError(String(e)));
          }}
        />
        {extension?.inspector?.(extensionContext)}
        {element && element.type !== 'instance' && element.type !== 'react' && (
          <Section title="HTML semantics">
            <label>
              HTML meaning
              <select
                aria-label="Element HTML meaning"
                value={element.web?.tag ?? ''}
                onChange={(event) =>
                  apply(
                    patchDesign([element.id], {
                      web: {
                        ...element.web,
                        tag: event.target.value ? (event.target.value as DesignWebTag) : undefined,
                      },
                    }),
                  )
                }
              >
                <option value="">意味を選択</option>
                {designWebTagsFor(element.type).map((tag) => (
                  <option key={tag}>{tag}</option>
                ))}
              </select>
            </label>
            {element.type === 'image' && (
              <p>imgには画像の内容を説明するaltが必要です。Image alt textを設定してください。</p>
            )}
          </Section>
        )}
        {element && (
          <>
            <Section title={`${element.type} settings`}>
              <CommitInput
                label="Layer name"
                value={element.name}
                onCommit={(name) => apply(patchDesign(ids, { name }))}
              />
              <label className="ep-field">
                Parent frame / group
                <select
                  aria-label="Parent layer"
                  value={element.parentId ?? ''}
                  onChange={(e) => apply(reparentElement(element.id, e.target.value || undefined))}
                >
                  <option value="">Root</option>
                  {content.elements
                    .filter((e) => ['frame', 'group'].includes(e.type) && e.id !== element.id)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </select>
              </label>
              {element.type === 'frame' && (
                <>
                  <label className="ep-field">
                    Frame preset
                    <select
                      aria-label="Frame preset"
                      onChange={(e) => {
                        if (!e.target.value) return;
                        const [width, height] = e.target.value.split('x').map(Number);
                        if (element.layout?.sizing === 'hug')
                          setPreset({ id: element.id, width, height });
                        else apply(applyFramePreset(element.id, width, height));
                      }}
                      value={
                        ['390x844', '1440x900', '800x600'].includes(
                          `${element.bounds.width}x${element.bounds.height}`,
                        )
                          ? `${element.bounds.width}x${element.bounds.height}`
                          : ''
                      }
                    >
                      <option value="">Custom</option>
                      <option value="390x844">Phone · 390×844</option>
                      <option value="1440x900">Desktop · 1440×900</option>
                      <option value="800x600">Card sheet · 800×600</option>
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={element.clipContent ?? false}
                      onChange={(e) => apply(patchDesign(ids, { clipContent: e.target.checked }))}
                    />{' '}
                    Clip frame content
                  </label>
                </>
              )}
            </Section>
            {['frame', 'group'].includes(element.type) && (
              <Section title="Auto layout">
                <label className="ep-field">
                  Direction
                  <select
                    aria-label="Layout direction"
                    value={element.layout?.direction ?? 'absolute'}
                    onChange={(e) =>
                      apply(
                        patchDesign(ids, {
                          layout: {
                            gap: 16,
                            padding: 16,
                            align: 'start',
                            sizing: 'fixed',
                            ...element.layout,
                            direction: e.target.value as 'row' | 'column' | 'absolute',
                          },
                        }),
                      )
                    }
                  >
                    {['absolute', 'row', 'column'].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                {element.layout && (
                  <>
                    <div className="ep-fields">
                      <CommitInput
                        label="Layout gap (px)"
                        type="number"
                        min={0}
                        value={element.layout.gap}
                        onCommit={(v) =>
                          apply(
                            patchDesign(ids, { layout: { ...element.layout!, gap: Number(v) } }),
                          )
                        }
                      />
                      <CommitInput
                        label="Layout padding (px)"
                        type="number"
                        min={0}
                        value={element.layout.padding}
                        onCommit={(v) =>
                          apply(
                            patchDesign(ids, {
                              layout: { ...element.layout!, padding: Number(v) },
                            }),
                          )
                        }
                      />
                    </div>
                    <label className="ep-field">
                      Alignment
                      <select
                        aria-label="Layout alignment"
                        value={element.layout.align}
                        onChange={(e) =>
                          apply(
                            patchDesign(ids, {
                              layout: {
                                ...element.layout!,
                                align: e.target.value as 'start' | 'center' | 'end',
                              },
                            }),
                          )
                        }
                      >
                        {['start', 'center', 'end'].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <label className="ep-field">
                      Container sizing
                      <select
                        aria-label="Container sizing"
                        value={element.layout.sizing}
                        onChange={(e) =>
                          apply(
                            patchDesign(ids, {
                              layout: {
                                ...element.layout!,
                                sizing: e.target.value as 'fixed' | 'hug',
                              },
                            }),
                          )
                        }
                      >
                        <option>fixed</option>
                        <option>hug</option>
                      </select>
                    </label>
                  </>
                )}
              </Section>
            )}
            <Section title="Size behavior" open={false}>
              <select
                aria-label="Element sizing"
                value={element.sizing ?? 'fixed'}
                onChange={(e) =>
                  apply(patchDesign(ids, { sizing: e.target.value as 'fixed' | 'hug' | 'fill' }))
                }
              >
                <option>fixed</option>
                <option>hug</option>
                <option>fill</option>
              </select>
              {content.elements.some((p) => p.id === element.parentId && p.type === 'frame') &&
                (['horizontal', 'vertical'] as const).map((axis) => (
                  <label key={axis} className="ep-field">
                    {axis} constraint
                    <select
                      aria-label={`${axis} constraint`}
                      value={
                        element.constraints?.[axis] ?? (axis === 'horizontal' ? 'left' : 'top')
                      }
                      onChange={(e) =>
                        apply(
                          patchDesign(ids, {
                            constraints: {
                              horizontal: 'left',
                              vertical: 'top',
                              ...element.constraints,
                              [axis]: e.target.value,
                            },
                          }),
                        )
                      }
                    >
                      {(axis === 'horizontal'
                        ? ['left', 'right', 'center', 'stretch', 'scale']
                        : ['top', 'bottom', 'center', 'stretch', 'scale']
                      ).map((rule) => (
                        <option key={rule}>{rule}</option>
                      ))}
                    </select>
                  </label>
                ))}
            </Section>
            {component && (
              <Section title="Component instance">
                <p>
                  {component.name} ·{' '}
                  {definition ? 'Editing shared definition' : 'Instance overrides only'}
                </p>
                <button aria-pressed={definition} onClick={() => setDefinition(!definition)}>
                  Edit shared definition
                </button>
                <button onClick={() => apply(resetInstance(element.id))}>Reset overrides</button>
                <button onClick={() => apply(detachInstance(element.id))}>Detach instance</button>
                {(
                  component.elements ?? [
                    { id: 'root', name: component.name, ...component.template },
                  ]
                ).map((part) => {
                  const override = element.overrides?.[part.id];
                  return (
                    <div key={part.id} className="component-card">
                      <strong>{part.name}</strong>
                      <DesignInteractionSettings
                        content={content}
                        label={`Part interaction ${part.name}`}
                        value={definition ? part.interactions : override?.interactions}
                        inherited={part.interactions}
                        onChange={(value) =>
                          apply(setDesignInteractions(element.id, value, part.id, definition))
                        }
                        onInherit={
                          definition
                            ? undefined
                            : () => apply(setDesignInteractions(element.id, undefined, part.id))
                        }
                      />
                      <CommitInput
                        label={`Component text ${part.name}`}
                        value={definition ? part.text : (override?.text ?? part.text)}
                        onCommit={(text) =>
                          apply(
                            definition
                              ? part.id === 'root'
                                ? updateComponent(component.id, { text })
                                : updateComponentPart(component.id, part.id, { text })
                              : overrideInstance(element.id, part.id, { text }),
                          )
                        }
                      />
                      <CommitInput
                        label={`Component fill ${part.name}`}
                        value={definition ? part.fill : (override?.fill ?? part.fill)}
                        onCommit={(fill) =>
                          apply(
                            definition
                              ? part.id === 'root'
                                ? updateComponent(component.id, { fill })
                                : updateComponentPart(component.id, part.id, { fill })
                              : overrideInstance(element.id, part.id, { fill }),
                          )
                        }
                      />
                    </div>
                  );
                })}
              </Section>
            )}
            <Section title="Shared styles">
              <label className="ep-field">
                Style
                <select
                  aria-label="Shared style"
                  value={element.styleId ?? ''}
                  onChange={(e) =>
                    apply(patchDesign(ids, { styleId: e.target.value || undefined }))
                  }
                >
                  <option value="">Local appearance</option>
                  {content.styles?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => {
                  const style = {
                    id: newId('style'),
                    name: `Style ${(content.styles?.length ?? 0) + 1}`,
                    appearance: {
                      fill: element.fill,
                      stroke: element.stroke,
                      typography: element.typography,
                    },
                  };
                  apply(
                    command('design.style', 'Create shared style', (d) => ({
                      ...d,
                      styles: [...(d.styles ?? []), style],
                      elements: d.elements.map((e) =>
                        ids.includes(e.id) ? { ...e, styleId: style.id } : e,
                      ),
                    })),
                  );
                }}
              >
                Create style from selection
              </button>
              {element.styleId && (
                <>
                  <p className="hint">
                    Updates affect all{' '}
                    {content.elements.filter((e) => e.styleId === element.styleId).length} linked
                    elements.
                  </p>
                  <CommitInput
                    label="Shared style fill"
                    value={
                      content.styles?.find((s) => s.id === element.styleId)?.appearance.fill ??
                      element.fill
                    }
                    onCommit={(fill) =>
                      apply(
                        command('design.style-update', 'Update shared style', (d) => ({
                          ...d,
                          styles: d.styles?.map((s) =>
                            s.id === element.styleId
                              ? { ...s, appearance: { ...s.appearance, fill } }
                              : s,
                          ),
                        })),
                      )
                    }
                  />
                </>
              )}
            </Section>
          </>
        )}
      </fieldset>
    </>
  );
  const toolbar = (
    <>
      <ReferenceTools
        identity={ids.join(',')}
        resolver={references}
        readOnly={readOnly}
        insert={(reference, src, label) =>
          add('image', {
            reference,
            src,
            alt: label,
            imageFit: 'fit',
            bounds: { x: 80, y: 140, width: 700, height: 320 },
          })
        }
      />
      <InsertTools
        onShape={(shape: ShapeKind) => add('shape', { shape, text: '' })}
        onText={() => add('text')}
        onImage={(f) => void image(f)}
        readOnly={readOnly}
      />
      <IconButton icon={Frame} label="Add frame" onClick={() => add('frame')} disabled={readOnly} />
      <ArrangeMenu
        count={ids.length}
        readOnly={readOnly}
        onAction={action}
        onAlign={(mode) => {
          const parent = content.elements.find((e) => e.id === chosen[0]?.parentId);
          if (reference === 'page' && !parent) {
            setError('Select objects in a frame to align to a parent');
            return;
          }
          apply(alignElements(ids, mode, reference === 'page' ? parent?.bounds : undefined));
        }}
        reference={reference}
        onReference={setReference}
      />
      <EditMenu onAction={action} readOnly={readOnly} />
      <IconButton
        icon={Component}
        label="Make component"
        disabled={!ids.length || readOnly}
        reason="Select one or more elements"
        onClick={() => {
          const componentId = newId('component');
          if (apply(createComponent(ids, componentId))) setPublication(componentId);
        }}
      />
      <Menu label="Export design" icon={Download}>
        <CommitInput
          label="Export padding (px)"
          type="number"
          min={0}
          value={padding}
          onCommit={(v) => setPadding(Number(v))}
        />
        <label>
          <input
            type="checkbox"
            checked={transparent}
            onChange={(e) => setTransparent(e.target.checked)}
          />{' '}
          Transparent background
        </label>
        <select
          aria-label="Design export scale"
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
        >
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
        {(['svg', 'png'] as const).map((format) =>
          ['all', 'selection', 'frames'].map((scope) => (
            <button key={format + scope} onClick={() => void output(format, scope)}>
              Export {scope} {format.toUpperCase()}
            </button>
          )),
        )}
      </Menu>
    </>
  );
  const left = (
    <>
      <div className="navigator-tabs">
        <button onClick={() => setTab('layers')}>Layers</button>
        <button onClick={() => setTab('components')}>Components</button>
      </div>
      {tab === 'layers' ? (
        <LayerNavigator
          virtualize
          entries={content.elements.map((e) => ({ ...e, type: e.type }))}
          selected={ids}
          onSelect={choose}
          onRename={(id, name) => apply(patchDesign([id], { name }))}
          onState={(id, patch) => apply(patchDesign([id], patch))}
          onReparent={(id, parent) => apply(reparentElement(id, parent))}
          onReorder={(id, delta) => apply(arrangeDesign([id], delta < 0 ? 'backward' : 'forward'))}
          readOnly={readOnly}
        />
      ) : (
        content.components.map((c) => (
          <div className="component-card" key={c.id}>
            <strong>{c.name}</strong>
            <button disabled={readOnly} onClick={() => setPublication(c.id)}>
              React公開設定 {c.name}
            </button>
            <button disabled={readOnly} onClick={() => apply(insertInstance(c.id))}>
              <Plus size={14} /> Insert {c.name}
            </button>
          </div>
        ))
      )}
      <Section title="Frames">
        {content.elements
          .filter((e) => e.type === 'frame')
          .map((e) => (
            <button
              key={e.id}
              onClick={() => {
                choose([e.id]);
                fit([e.id]);
              }}
            >
              {e.name}
            </button>
          ))}
      </Section>
    </>
  );
  return (
    <>
      <DesignPrototypeController
        control={prototypeControl}
        content={{ ...content, elements: projectedElements }}
        prototype={prototype}
      />
      <EditorLayout
        viewKey="design"
        leftLabel="Design navigator"
        inspectorLabel="Design inspector"
        toolbar={
          <>
            <button
              onClick={() => prototypeControl.current?.open()}
              disabled={
                !content.elements.some((element) => element.type === 'frame' && !element.hidden)
              }
            >
              Open prototype
            </button>
            {toolbar}
            {extension?.toolbar?.(extensionContext)}
          </>
        }
        left={
          <>
            {left}
            {extension?.library?.(extensionContext)}
          </>
        }
        inspector={inspector}
        status={
          <>
            <span>
              {content.elements.length} elements · {ids.length} selected
            </span>
            <IconButton
              icon={Scan}
              label="Fit selection"
              disabled={!ids.length}
              onClick={() => fit(ids)}
            />
            <span className="ep-spacer" />
            <CanvasControls
              view={view}
              onChange={setView}
              onFit={() => fit()}
              fitLabel="Fit design"
              minZoom={0.001}
            />
          </>
        }
        {...layout}
      >
        <div ref={viewport} style={{ height: '100%' }}>
          {error && (
            <div className="surface-error" role="alert">
              {error}
              <button onClick={() => setError('')}>Dismiss</button>
            </div>
          )}
          <CanvasStage
            virtualize
            label="Design canvas"
            space="infinite"
            previewTransform={(ids, delta) => designPreview(content, ids, delta)}
            hideControls
            view={view}
            onViewChange={setView}
            selected={canvasSelection}
            targets={designPaintOrder(content)
              .filter((e) => !canvasOwners.get(e.id))
              .map((e) => ({
                ...e,
                label: `Design object ${e.name}`,
                paintBounds: extension?.render
                  ? undefined
                  : designPaintBounds(project(e), e.bounds, e.rotation),
                text: appearance(content, e).text,
                textDrawing: project(e).find((drawing) => drawing.id === e.id),
                editableText: e.type === 'text' || e.type === 'shape' || e.type === 'rectangle',
                hitBox: e.type === 'text' || e.type === 'instance' || e.type === 'react',
                container: e.type === 'group',
                textParts: [...scopedTexts.values()]
                  .filter((p) => p.rootId === e.id)
                  .map((p) => p.target),
              }))}
            onSelect={choose}
            readOnly={readOnly}
            onTransform={(ids, delta) => apply(transformElements(ids, delta))}
            onDelete={() => action('delete')}
            onAction={action}
            onEditText={(id, text, runs, base) => {
              const part = scopedTexts.get(id);
              if (
                part &&
                base &&
                canonicalJson([part.target.text, part.target.runs ?? null]) !==
                  canonicalJson([base.text, base.runs ?? null])
              ) {
                setError(
                  `${id}: 編集開始後に文字または書式が変更されました。未確定の入力を保持しています。`,
                );
                return false;
              }
              setError('');
              return apply(
                part
                  ? overrideInstance(part.rootId, part.partId, { text, runs })
                  : patchDesign([id], { text, runs }),
              );
            }}
            onImage={(f) => void image(f)}
            render={(target) => {
              const raw = elements.get(target.id)!;
              const external = extension?.render?.(raw, target.bounds);
              if (external) return external;
              return (
                <DesignDrawings
                  drawings={project(raw, target.bounds, target.rotation).map((original) => {
                    const drawing = raw.reference
                      ? { ...original, src: projectedById.get(raw.id)?.src }
                      : original;
                    return target.textParts?.some(
                      (part) => part.id === target.editingTextId && part.drawingId === drawing.id,
                    )
                      ? { ...drawing, text: '', runs: undefined }
                      : drawing;
                  })}
                  textParts={target.textParts}
                />
              );
            }}
          />
          {publication && content.components.some((component) => component.id === publication) && (
            <ComponentPublicationDialog
              key={publication}
              content={content}
              id={publication}
              readOnly={readOnly || !!publicationReadOnlyReason}
              readOnlyReason={publicationReadOnlyReason}
              apply={apply}
              diagnostics={extension?.publicationDiagnostics}
              onClose={() => {
                setPublication(undefined);
                onPublicationClosed?.();
              }}
            />
          )}
        </div>
      </EditorLayout>
      {preset && (
        <Dialog title="Frame preset constraints" onClose={() => setPreset(undefined)}>
          <p>
            Hugは子要素から寸法を計算するため、{preset.width}×{preset.height}
            と競合します。固定寸法へ切り替える方法を選んでください。
          </p>
          <button
            disabled={readOnly}
            onClick={() => {
              if (apply(applyFramePreset(preset.id, preset.width, preset.height)))
                setPreset(undefined);
            }}
          >
            Use fixed frame size
          </button>
          <button
            disabled={
              readOnly ||
              !['row', 'column'].includes(
                content.elements.find((element) => element.id === preset.id)?.layout?.direction ??
                  'absolute',
              )
            }
            onClick={() => {
              if (apply(applyFramePreset(preset.id, preset.width, preset.height, true)))
                setPreset(undefined);
            }}
          >
            Fit children to fixed frame
          </button>
          {!['row', 'column'].includes(
            content.elements.find((element) => element.id === preset.id)?.layout?.direction ??
              'absolute',
          ) && (
            <p>
              絶対配置では子要素の自動調整を利用できません。Use fixed frame
              sizeでフレーム寸法を変更してください。
            </p>
          )}
          <button onClick={() => setPreset(undefined)}>Cancel preset</button>
        </Dialog>
      )}
    </>
  );
}

// Keep visibility outside both the expensive Surface and the mobile toolbar menu.
// Closing that menu must not unmount an active prototype or lose its navigation.
function DesignPrototypeController({
  control,
  content,
  prototype,
}: {
  control: Ref<{ open(): void }>;
  content: DesignContent;
  prototype?: DesignSurfaceProps['prototype'];
}) {
  const [prototyping, setPrototyping] = useState(false);
  useImperativeHandle(control, () => ({ open: () => setPrototyping(true) }), []);
  return prototyping ? (
    <div
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase()))
          event.stopPropagation();
      }}
    >
      <Dialog title="Design prototype" onClose={() => setPrototyping(false)}>
        <div style={{ height: 'min(72vh, 800px)', width: 'min(660px, calc(94vw - 48px))' }}>
          <DesignPrototypeSurface
            content={content}
            {...prototype}
            onClose={() => setPrototyping(false)}
          />
        </div>
      </Dialog>
    </div>
  ) : null;
}
