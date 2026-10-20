import {
  ReferenceInspector,
  ReferenceWarnings,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { newId } from '@editor-platform/artifact-core';
import { command, type Bounds, type EditorCommand } from '@editor-platform/editor-core';
import { CommitInput, Section } from '@editor-platform/editor-ui';
import { VisualInspector, readImage } from '@editor-platform/canvas-ui';
import { DesignInteractionSettings, DesignPrototypeSettings } from './prototype-settings';
import { setDesignInteractions } from './prototype';
import {
  appearance,
  designDrawings,
  designInstanceElements,
  detachInstance,
  overrideInstance,
  patchDesign,
  reparentElement,
  resetInstance,
  updateComponent,
  updateComponentPart,
  applyFramePreset,
  type DesignComponent,
  type DesignContent,
  type DesignElement,
} from './model';
import { designWebTagsFor, type DesignWebTag } from './web-contract';
import type { DesignExtensionContext, DesignSurfaceExtension } from './view';
// Inspector sections of the Design surface. Each section edits the single selected element.
export interface DesignInspectorProps {
  references: ReferenceSurfaceProps['references'];
  content: DesignContent;
  element: DesignElement | undefined;
  chosen: DesignElement[];
  ids: string[];
  readOnly: boolean;
  apply: (cmd: EditorCommand<DesignContent>) => boolean;
  geometry: (patch: Partial<Bounds>) => void;
  setError: (message: string) => void;
  extension: DesignSurfaceExtension | undefined;
  extensionContext: DesignExtensionContext;
  setPreset: (preset: FramePresetRequest) => void;
  definition: boolean;
  setDefinition: (definition: boolean) => void;
}
export interface FramePresetRequest {
  id: string;
  width: number;
  height: number;
}
interface SectionProps {
  content: DesignContent;
  element: DesignElement;
  ids: string[];
  apply: (cmd: EditorCommand<DesignContent>) => boolean;
}
export function DesignInspector({
  references,
  content,
  element,
  chosen,
  ids,
  readOnly,
  apply,
  geometry,
  setError,
  extension,
  extensionContext,
  setPreset,
  definition,
  setDefinition,
}: DesignInspectorProps) {
  const component = element?.componentId
    ? content.components.find((c) => c.id === element.componentId)
    : undefined;
  const section = element && { content, element, ids, apply };
  return (
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
        {section && element.type !== 'instance' && element.type !== 'react' && (
          <HtmlSemanticsSection {...section} />
        )}
        {section && (
          <>
            <ElementSettingsSection {...section} setPreset={setPreset} />
            {['frame', 'group'].includes(section.element.type) && (
              <AutoLayoutSection {...section} />
            )}
            <SizeBehaviorSection {...section} />
            {component && (
              <ComponentInstanceSection
                {...section}
                component={component}
                definition={definition}
                setDefinition={setDefinition}
              />
            )}
            <SharedStylesSection {...section} />
          </>
        )}
      </fieldset>
    </>
  );
}
function HtmlSemanticsSection({ element, apply }: SectionProps) {
  return (
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
  );
}
function ElementSettingsSection({
  content,
  element,
  ids,
  apply,
  setPreset,
}: SectionProps & { setPreset: (preset: FramePresetRequest) => void }) {
  return (
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
                if (element.layout?.sizing === 'hug') setPreset({ id: element.id, width, height });
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
  );
}
function AutoLayoutSection({ element, ids, apply }: SectionProps) {
  return (
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
                apply(patchDesign(ids, { layout: { ...element.layout!, gap: Number(v) } }))
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
  );
}
function SizeBehaviorSection({ content, element, ids, apply }: SectionProps) {
  return (
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
              value={element.constraints?.[axis] ?? (axis === 'horizontal' ? 'left' : 'top')}
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
  );
}
function ComponentInstanceSection({
  content,
  element,
  apply,
  component,
  definition,
  setDefinition,
}: SectionProps & {
  component: DesignComponent;
  definition: boolean;
  setDefinition: (definition: boolean) => void;
}) {
  const instanceParts = component.elements
    ? new Map(designInstanceElements(content, element, (id) => id).map((p) => [p.id, p]))
    : undefined;
  return (
    <Section title="Component instance">
      <p>
        {component.name} · {definition ? 'Editing shared definition' : 'Instance overrides only'}
      </p>
      <button aria-pressed={definition} onClick={() => setDefinition(!definition)}>
        Edit shared definition
      </button>
      <button onClick={() => apply(resetInstance(element.id))}>Reset overrides</button>
      <button onClick={() => apply(detachInstance(element.id))}>Detach instance</button>
      {(component.elements ?? [{ id: 'root', name: component.name, ...component.template }]).map(
        (part) => {
          const override = element.overrides?.[part.id];
          const displayed = instanceParts?.get(part.id);
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
                value={definition ? part.text : (displayed?.text ?? override?.text ?? part.text)}
                onCommit={(text) =>
                  apply(
                    definition
                      ? part.id === 'root'
                        ? updateComponent(component.id, { text })
                        : updateComponentPart(component.id, part.id, { text })
                      : overrideInstance(element.id, part.id, { text, runs: undefined }),
                  )
                }
              />
              <CommitInput
                label={`Component fill ${part.name}`}
                value={definition ? part.fill : (displayed?.fill ?? override?.fill ?? part.fill)}
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
        },
      )}
    </Section>
  );
}
function SharedStylesSection({ content, element, ids, apply }: SectionProps) {
  return (
    <Section title="Shared styles">
      <label className="ep-field">
        Style
        <select
          aria-label="Shared style"
          value={element.styleId ?? ''}
          onChange={(e) => apply(patchDesign(ids, { styleId: e.target.value || undefined }))}
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
            {content.elements.filter((e) => e.styleId === element.styleId).length} linked elements.
          </p>
          <CommitInput
            label="Shared style fill"
            value={
              content.styles?.find((s) => s.id === element.styleId)?.appearance.fill ?? element.fill
            }
            onCommit={(fill) =>
              apply(
                command('design.style-update', 'Update shared style', (d) => ({
                  ...d,
                  styles: d.styles?.map((s) =>
                    s.id === element.styleId ? { ...s, appearance: { ...s.appearance, fill } } : s,
                  ),
                })),
              )
            }
          />
        </>
      )}
    </Section>
  );
}
