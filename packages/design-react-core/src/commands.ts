import { clone } from '@editor-platform/artifact-core';
import {
  command,
  immutableCommand,
  withCommandReads,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  makeDesignElement,
  isDesign,
  layoutDesign,
  type DesignContent,
  type DesignElement,
} from '@editor-platform/design/model';
import { type DesignWebSettings } from '@editor-platform/design/web-contract';
import {
  reactComponentKey,
  reactUiInsertionProblem,
  prepareReactUiRevision,
  loadReactUiDocument,
  type ReactUiDocument,
  type RegisteredReactComponent,
  type JsonValue,
  type ReactUiBinding,
} from '@editor-platform/react-ui-core';
import {
  convertDesignToReact,
  exportDesignReact,
  reviewDesignReactDocumentRegeneration,
  retainedDesignPublications,
  designReactPublications,
  designReactSourceHash,
  type DesignReactConversion,
  type DesignReactBundle,
} from './convert';
import { reuseHash } from '@editor-platform/reuse-core';
export function configureDesignWeb(settings: DesignWebSettings): EditorCommand<DesignContent> {
  return command('design.web.configure', 'Configure React Web export', (d) => ({
    ...d,
    web: {
      ...clone(settings),
      ...(d.web?.publications ? { publications: clone(d.web.publications) } : {}),
      ...(d.web?.accepted ? { accepted: clone(d.web.accepted) } : {}),
    },
  }));
}
export function insertDesignReact(
  registration: RegisteredReactComponent,
  id: string,
  parentId?: string,
  slotId?: string,
): EditorCommand<DesignContent> {
  return withCommandReads<DesignContent>(
    command('design.react.insert', `Insert React ${registration.name}`, (d) => {
      if (!d.web) throw new Error('Configure a pinned Web environment first');
      const parent = d.elements.find((e) => e.id === parentId);
      if (parentId && !parent) throw new Error('Choose an existing parent');
      if (d.elements.some((e) => e.id === id)) throw new Error('Node ID already exists');
      const retained = d.web.registrations.find(
        (c) => reactComponentKey(c.ref) === reactComponentKey(registration.ref),
      );
      if (retained && reuseHash(retained) !== reuseHash(registration))
        throw new Error('Retained registration does not match');
      const problem = reactUiInsertionProblem(registration);
      if (problem) throw new Error(problem);
      if (parent?.react) {
        const owner = d.web.registrations.find(
          (c) => reactComponentKey(c.ref) === reactComponentKey(parent.react!.component),
        );
        if (!owner || reuseHash(owner.ref) !== reuseHash(parent.react.component))
          throw new Error('Exact parent registration is unavailable');
        const slot = slotId && owner.slots[slotId];
        if (!slot) throw new Error('Choose a published slot');
        const count = (parent.react.slots[slotId!] ?? []).length + 1;
        if (count > slot.maximum || count < slot.minimum)
          throw new Error(`Slot cardinality outside limits: ${parent.id}/${slotId}`);
        if (
          !slot.accepts.some(
            (ref) =>
              ref.registryId === registration.ref.registryId &&
              ref.componentId === registration.ref.componentId,
          )
        )
          throw new Error(`Component is not accepted by slot: ${parent.id}/${slotId}`);
      } else if (slotId) throw new Error('Target is not a registered React slot');
      const element: DesignElement = {
        ...makeDesignElement('react'),
        id,
        name: `React ${registration.name}`,
        bounds: {
          x: parent ? parent.bounds.x + 24 : 60,
          y: parent ? parent.bounds.y + 24 : 60,
          width: 320,
          height: 80,
        },
        ...(parentId ? { parentId } : {}),
        react: {
          component: clone(registration.ref),
          import: clone(registration.import),
          props: clone(registration.sampleProps),
          bindings: {},
          slots: {},
        },
      };
      const registrations = d.web.registrations.some(
        (c) => reactComponentKey(c.ref) === reactComponentKey(registration.ref),
      )
        ? d.web.registrations
        : [...d.web.registrations, clone(registration)];
      return layoutDesign({
        ...d,
        web: { ...d.web, registrations },
        elements: [
          ...d.elements.map((e) =>
            e.id === parentId && e.react
              ? {
                  ...e,
                  react: {
                    ...e.react,
                    slots: { ...e.react.slots, [slotId!]: [...(e.react.slots[slotId!] ?? []), id] },
                  },
                }
              : e,
          ),
          element,
        ],
      });
    }),
    { content: ['*'] },
  );
}
export function editDesignReact(
  id: string,
  edit: { prop: string; value?: JsonValue; binding?: ReactUiBinding | null },
): EditorCommand<DesignContent> {
  return command('design.react.edit', 'Edit public React input', (d) => ({
    ...d,
    elements: d.elements.map((e) => {
      if (e.id !== id || !e.react) return e;
      const react = clone(e.react);
      if (Object.hasOwn(edit, 'value')) {
        react.props[edit.prop] = edit.value!;
        delete react.bindings[edit.prop];
      } else {
        delete react.props[edit.prop];
        if (edit.binding) react.bindings[edit.prop] = clone(edit.binding);
        else delete react.bindings[edit.prop];
      }
      return { ...e, react };
    }),
  }));
}
function assignSlotChildren(
  d: DesignContent,
  parentId: string,
  slotId: string,
  childIds: string[],
  native: boolean,
) {
  if (
    new Set(childIds).size !== childIds.length ||
    childIds.some((id) => !d.elements.some((e) => e.id === id))
  )
    throw new Error('Choose existing distinct slot children');
  const parent = d.elements.find((e) => e.id === parentId)!;
  const removed = (parent.react?.slots[slotId] ?? parent.webSlots?.[slotId] ?? []).filter(
    (id) => !childIds.includes(id),
  );
  const affected = new Set([parentId]);
  const elements = d.elements.map((e) => {
    const clean = (slots: Record<string, string[]>) =>
      Object.fromEntries(
        Object.entries(slots).map(([key, ids]) => [
          key,
          ids.filter((id) => !childIds.includes(id)),
        ]),
      );
    let next = e;
    if (
      Object.values(e.react?.slots ?? e.webSlots ?? {})
        .flat()
        .some((id) => childIds.includes(id))
    ) {
      affected.add(e.id);
      next = {
        ...e,
        ...(e.react ? { react: { ...e.react, slots: clean(e.react.slots) } } : {}),
        ...(e.webSlots ? { webSlots: clean(e.webSlots) } : {}),
      };
    }
    if (e.id === parentId)
      next = native
        ? { ...next, webSlots: { ...next.webSlots, [slotId]: clone(childIds) } }
        : {
            ...next,
            react: { ...next.react!, slots: { ...next.react!.slots, [slotId]: clone(childIds) } },
          };
    if (childIds.includes(e.id)) next = { ...next, parentId };
    else if (removed.includes(e.id) && e.parentId === parentId)
      next = { ...next, parentId: undefined };
    return next;
  });
  const next = { ...d, elements };
  if (!isDesign(next)) throw new Error('Slot assignment must preserve the native hierarchy');
  for (const id of affected) {
    const result = convertDesignToReact(next, [id]);
    if (result.diagnostics.length)
      throw new Error(result.diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n'));
  }
  return next;
}
export function assignDesignReactSlot(
  parentId: string,
  slotId: string,
  childIds: string[],
): EditorCommand<DesignContent> {
  return withCommandReads(
    command('design.react.slot', 'Assign native nodes to public slot', (d) => {
      const parent = d.elements.find((e) => e.id === parentId);
      const registration = d.web?.registrations.find(
        (c) =>
          parent?.react && reactComponentKey(c.ref) === reactComponentKey(parent.react.component),
      );
      if (!parent?.react || !registration?.slots[slotId])
        throw new Error('Choose a published slot');
      return assignSlotChildren(d, parentId, slotId, childIds, false);
    }),
    { content: ['*'] },
  );
}
export function adoptDesignReactRevision(
  id: string,
  next: RegisteredReactComponent,
  propMap: Record<string, string>,
  slotMap: Record<string, string>,
): EditorCommand<DesignContent> {
  return command('design.react.adopt', 'Adopt explicit React revision', (d) => {
    const conversion = convertDesignToReact(d, [id]);
    const plan = prepareReactUiRevision(conversion.document, {
      component: next,
      nodeIds: [id],
      propMap,
      slotMap,
    });
    const updated = plan.command.apply(conversion.document).nodes.find((n) => n.id === id)!;
    return {
      ...d,
      web: {
        ...d.web!,
        registrations: [
          ...d.web!.registrations.filter(
            (c) => reactComponentKey(c.ref) !== reactComponentKey(next.ref),
          ),
          clone(next),
        ],
      },
      elements: d.elements.map((e) =>
        e.id === id
          ? {
              ...e,
              react: {
                component: clone(next.ref),
                import: clone(next.import),
                props: clone(updated.props),
                slots: clone(updated.slots),
                bindings: clone(updated.bindings),
              },
            }
          : e,
      ),
    };
  });
}
export function acceptDesignConversion(bundle: DesignReactBundle): EditorCommand<DesignContent> {
  return withCommandReads(
    command('design.web.accept', 'Accept reviewed React conversion', (d) => {
      if (bundle.mode !== 'web' && bundle.mode !== 'svg')
        throw new Error('Choose an explicit reviewed output mode');
      // Source precondition is checked again inside the ordinary local/shared transaction.
      if (!d.web || bundle.sourceHash !== designReactSourceHash(d))
        throw new Error('Native source changed after conversion review');
      const conversion =
        bundle.mode === 'web' ? convertDesignToReact(d, bundle.rootIds) : undefined;
      if (conversion?.diagnostics.length)
        throw new Error(conversion.diagnostics.map((x) => x.message).join('\n'));
      if (
        conversion &&
        reuseHash(bundle.publications) !== reuseHash(designReactPublications(conversion))
      )
        throw new Error('Reviewed native publication identities changed');
      const next = {
        ...d,
        web: {
          ...d.web,
          publications: conversion
            ? mergePublications(d, conversion)
            : retainedDesignPublications(d.web),
          accepted: {
            sourceHash: bundle.sourceHash,
            fingerprint: bundle.fingerprint,
            fileHashes: Object.fromEntries(
              Object.entries(bundle.files).map(([path, value]) => [path, reuseHash(value)]),
            ),
          },
        },
      };
      if (!isDesign(next))
        throw new Error('Accepted conversion metadata is not valid native Design');
      return next;
    }),
    { content: ['*'] },
  );
}
function mergePublications(d: DesignContent, conversion: DesignReactConversion) {
  return [
    ...new Map(
      [...retainedDesignPublications(d.web!), ...designReactPublications(conversion)].map((ref) => [
        reactComponentKey(ref),
        ref,
      ]),
    ).values(),
  ];
}
/** Registering with a Host retains the same immutable publication history as accepting output. */
export function retainDesignPublications(
  review: DesignReactConversion,
): EditorCommand<DesignContent> {
  return withCommandReads(
    command('design.web.publish', 'Retain reviewed native publications', (d) => {
      const current = convertDesignToReact(d);
      if (
        current.sourceHash !== review.sourceHash ||
        current.diagnostics.length ||
        reuseHash(designReactPublications(current)) !== reuseHash(designReactPublications(review))
      )
        throw new Error('Native publications changed after review');
      const next = { ...d, web: { ...d.web!, publications: mergePublications(d, current) } };
      if (!isDesign(next)) throw new Error('Publication metadata is not valid native Design');
      return next;
    }),
    { content: ['*'] },
  );
}
export { exportDesignReact };

/** Reviewed target bytes are checked inside the normal React UI command/authority path. */
export function applyDesignReactDocumentRegeneration(
  review: ReturnType<typeof reviewDesignReactDocumentRegeneration>,
) {
  if (review.conflicts.length)
    throw new Error(
      'Resolve React UI conflicts before applying regeneration: ' + review.conflicts.join(', '),
    );
  return immutableCommand(
    'design.regenerate',
    'Accept reviewed Design regeneration',
    (document: ReactUiDocument) => {
      if (reuseHash(document) !== review.target)
        throw new Error('React UI target changed after regeneration review');
      return loadReactUiDocument(review.document);
    },
  );
}

export function mapDesignElementToReact(
  id: string,
  registration: RegisteredReactComponent,
): EditorCommand<DesignContent> {
  return command('design.react.map', 'Map selected native element to registered React', (d) => {
    const existing = d.elements.find((e) => e.id === id);
    if (!d.web || !existing || existing.type === 'instance')
      throw new Error('Choose an ordinary native element');
    if (d.elements.some((e) => e.parentId === id))
      throw new Error(
        'Map leaf elements; move children to an explicitly accepted public slot first',
      );
    return {
      ...d,
      web: {
        ...d.web,
        registrations: d.web.registrations.some(
          (c) => reactComponentKey(c.ref) === reactComponentKey(registration.ref),
        )
          ? d.web.registrations
          : [...d.web.registrations, clone(registration)],
      },
      elements: d.elements.map((e) =>
        e.id === id
          ? {
              ...e,
              type: 'react',
              ...(e.vector ? { vector: undefined } : {}),
              react: {
                component: clone(registration.ref),
                import: clone(registration.import),
                props: clone(registration.sampleProps),
                bindings: {},
                slots: {},
              },
            }
          : e,
      ),
    };
  });
}

export function assignDesignNativeSlot(
  instanceId: string,
  slotId: string,
  childIds: string[],
): EditorCommand<DesignContent> {
  return withCommandReads(
    command('design.web.slot', 'Assign public native component slot', (d) => {
      const instance = d.elements.find((e) => e.id === instanceId),
        component = d.components.find((c) => c.id === instance?.componentId);
      if (instance?.type !== 'instance' || !component?.web?.slots?.[slotId])
        throw new Error('Choose a published native component slot');
      return assignSlotChildren(d, instanceId, slotId, childIds, true);
    }),
    { content: ['*'] },
  );
}
