import { command } from '@editor-platform/editor-core';
import { updateElement, type DesignExtensionContext } from '@editor-platform/design';
import type { DesignContent, DesignElement } from '@editor-platform/design/model';
import {
  designWebTags,
  type DesignWebComponent,
  type DesignWebSettings,
} from '@editor-platform/design/web-contract';
import { CommitInput } from '@editor-platform/editor-ui';
import {
  reactComponentKey,
  type JsonValue,
  type ReactUiRevisionCandidate,
  type RegisteredReactComponent,
} from '@editor-platform/react-ui-core';
import {
  adoptDesignReactRevision,
  assignDesignNativeSlot,
  assignDesignReactSlot,
  editDesignReact,
  mapDesignElementToReact,
} from '@editor-platform/design-react-core';
import { JsonInput } from './json-input';
// Inspector sections that Design React adds to the native Design surface.
type WebContent = DesignContent & { web: DesignWebSettings };
type Apply = DesignExtensionContext['apply'];
type Revision = Omit<ReactUiRevisionCandidate, 'nodeIds'> & { component: RegisteredReactComponent };

/** Web semantics, React mapping and public contracts of the selected native element. */
export function ReactElementInspector({
  content,
  element,
  registrations,
  revisions,
  readOnly,
  apply,
  setPreview,
}: {
  content: WebContent;
  element: DesignElement;
  registrations: RegisteredReactComponent[];
  revisions: Revision[];
  readOnly?: boolean;
  apply: Apply;
  setPreview: (id: string) => void;
}) {
  return (
    <>
      <NativeWebSettings
        content={content}
        element={element}
        registrations={registrations}
        readOnly={readOnly}
        apply={apply}
      />
      {element.react && (
        <ExternalReactInspector
          content={content}
          element={{ ...element, react: element.react }}
          revisions={revisions}
          apply={apply}
        />
      )}
      <PublicContractSettings content={content} element={element} apply={apply} />
      <button onClick={() => setPreview(element.id)}>Preview selected Design as React</button>
    </>
  );
}
/** HTML role, React mapping, responsive layout and link target of a native element. */
function NativeWebSettings({
  content,
  element,
  registrations,
  readOnly,
  apply,
}: {
  content: WebContent;
  element: DesignElement;
  registrations: RegisteredReactComponent[];
  readOnly?: boolean;
  apply: Apply;
}) {
  return (
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
            disabled={readOnly}
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
    </>
  );
}
/** Native slots, public props, bindings, page route and component contract. */
function PublicContractSettings({
  content,
  element,
  apply,
}: {
  content: WebContent;
  element: DesignElement;
  apply: Apply;
}) {
  return (
    <>
      {element.type === 'instance' &&
        Object.keys(
          content.components.find((c) => c.id === element.componentId)?.web?.slots ?? {},
        ).map((slot) => (
          <JsonInput
            key={element.id + slot}
            label={`Native React slot ${slot}`}
            value={element.webSlots?.[slot] ?? []}
            onApply={(value) => apply(assignDesignNativeSlot(element.id, slot, value as string[]))}
          />
        ))}
      {element.type === 'instance' && (
        <JsonInput
          key={element.id + 'props'}
          label="Native React public props"
          value={element.webProps ?? {}}
          onApply={(value) =>
            apply(updateElement(element.id, { webProps: value as Record<string, JsonValue> }))
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
                        content.web!.pages.find((p) => p.frameId === element.id)?.symbol ??
                        'Page' + (content.web!.pages.length + 1),
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
                  c.id === element.componentId ? { ...c, web: value as DesignWebComponent } : c,
                ),
              })),
            )
          }
        />
      )}
    </>
  );
}

/** Props, bindings, slots and revision adoption of an original React element. */
function ExternalReactInspector({
  content,
  element,
  revisions,
  apply,
}: {
  content: WebContent;
  element: DesignElement & { react: NonNullable<DesignElement['react']> };
  revisions: Revision[];
  apply: Apply;
}) {
  const c = content.web.registrations.find(
    (c) => reactComponentKey(c.ref) === reactComponentKey(element.react!.component),
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
          onApply={(value) => apply(assignDesignReactSlot(element.id, slot, value as string[]))}
        />
      ))}
      {revisions
        .filter(
          (r) =>
            r.component.ref.componentId === element.react!.component.componentId &&
            r.component.ref.version !== element.react!.component.version,
        )
        .map((r) => (
          <button
            key={r.component.ref.version}
            onClick={() =>
              apply(adoptDesignReactRevision(element.id, r.component, r.propMap, r.slotMap))
            }
          >
            Adopt React {r.component.ref.componentId} @{r.component.ref.version}
          </button>
        ))}
    </>
  );
}

export function RegenerationControls({
  targets,
  target,
  setTarget,
  readOnly,
  onReview,
}: {
  targets: { id: string; name: string }[];
  target: string;
  setTarget: (target: string) => void;
  readOnly?: boolean;
  onReview: () => void;
}) {
  return (
    <>
      <label>
        React UI regeneration target
        <select
          aria-label="React UI regeneration target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">Choose a retained conversion</option>
          {targets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <button disabled={readOnly || !target} onClick={onReview}>
        Review React UI regeneration
      </button>
    </>
  );
}
