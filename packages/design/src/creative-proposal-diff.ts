import type { EditorHostAdapter } from '@editor-platform/editor-host';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import {
  assertEditable,
  changedKeys,
  command,
  sameValue,
  transaction,
  type DomainDiff,
  type EditorCommand,
  type LocalDraftRevision,
  type ProposalDiffAdapter,
  type ProposedCommands,
} from '@editor-platform/editor-core';
import {
  appearance,
  applyDesignOverride,
  guardDesignCommand,
  overrideInstance,
  patchDesign,
  updateComponentPart,
  type DesignContent,
  type DesignElement,
} from './model';
import { captureDesignData, designId, rejectDesign } from './command-data';

/** IDs are opaque. A shared definition and an instance override are different addresses. */
export type CreativeDesignAddress =
  | { elementId: string; componentId?: never; instanceId?: never }
  | { elementId: string; componentId: string; instanceId?: string };
export interface CreativeDesignProposalScope {
  /** Every required part must change. */
  required: readonly CreativeDesignAddress[];
  /** Complete allowed set; defaults to required. */
  allowed?: readonly CreativeDesignAddress[];
}
const prefix = 'creative-design:';
function checkedAddress(value: CreativeDesignAddress): CreativeDesignAddress {
  const address = captureDesignData(value);
  if (!address || typeof address !== 'object' || Array.isArray(address))
    rejectDesign('creative-address', 'Expected a qualified Creative Design address');
  if (Object.keys(address).some((key) => !['elementId', 'componentId', 'instanceId'].includes(key)))
    rejectDesign('creative-nested-unsupported', 'Nested instance paths are unsupported');
  designId(address.elementId, 'elementId');
  if (address.componentId !== undefined) designId(address.componentId, 'componentId');
  if (address.instanceId !== undefined) {
    designId(address.instanceId, 'instanceId');
    if (!address.componentId)
      rejectDesign('creative-address', 'An instance part requires componentId');
  }
  return address;
}
/** Reversible qualified key used by semantic diff, changedElementIds and Host mappings. */
export function creativeDesignAddressKey(value: CreativeDesignAddress): string {
  const address = checkedAddress(value);
  return (
    prefix +
    JSON.stringify([address.instanceId ?? null, address.componentId ?? null, address.elementId])
  );
}
export function parseCreativeDesignAddress(key: string): CreativeDesignAddress {
  try {
    if (!key.startsWith(prefix)) throw Error();
    const fields: unknown = JSON.parse(key.slice(prefix.length));
    if (!Array.isArray(fields) || fields.length !== 3) throw Error();
    const [instanceId, componentId, elementId] = fields;
    if (
      (instanceId !== null && typeof instanceId !== 'string') ||
      (componentId !== null && typeof componentId !== 'string')
    )
      throw Error();
    const address = checkedAddress({
      elementId,
      ...(componentId !== null ? { componentId } : {}),
      ...(instanceId !== null ? { instanceId } : {}),
    } as CreativeDesignAddress);
    if (creativeDesignAddressKey(address) !== key) throw Error();
    return address;
  } catch {
    return rejectDesign('creative-address', 'Invalid qualified Creative Design key', key);
  }
}
function unique<T>(items: readonly T[], matches: (item: T) => boolean): T {
  const found = items.filter(matches);
  if (found.length !== 1)
    rejectDesign('creative-address', 'Creative Design address is missing or ambiguous');
  return found[0];
}
function resolve(content: DesignContent, value: CreativeDesignAddress) {
  const address = checkedAddress(value);
  if (!address.componentId) {
    const element = unique(content.elements, (e) => e.id === address.elementId);
    return { address, element, scope: content.elements, owner: undefined };
  }
  const component = unique(content.components, (c) => c.id === address.componentId);
  if (!component.elements)
    rejectDesign('creative-address', 'Creative part addresses require an elements-based component');
  const element = unique(component.elements, (e) => e.id === address.elementId);
  if (element.type === 'instance')
    rejectDesign('creative-nested-unsupported', 'Nested component instances are unsupported');
  if (!address.instanceId) return { address, element, scope: component.elements, owner: undefined };
  const owner = unique(content.elements, (e) => e.id === address.instanceId);
  if (owner.type !== 'instance' || owner.componentId !== address.componentId)
    rejectDesign('creative-address', 'Instance and component identity do not match');
  if (owner.overrides?.[element.id]?.overrides)
    rejectDesign('creative-nested-unsupported', 'Nested instance overrides are unsupported');
  const scope = component.elements.map((part) => {
    const override = owner.overrides?.[part.id];
    // Match native designPartAppearance: choose the override's style before
    // applying its direct values, then prevent a second style resolution.
    const styled = appearance(content, {
      ...part,
      ...(override?.styleId ? { styleId: override.styleId } : {}),
    });
    return { ...applyDesignOverride(styled, override), styleId: undefined };
  });
  return { address, element: unique(scope, (e) => e.id === element.id), scope, owner };
}
export interface CreativeDesignFocus {
  address: CreativeDesignAddress;
  key: string;
  /** Shared definitions have no unique canvas owner. */
  componentId?: string;
  /** Present for top-level elements and instance parts. */
  focusElementId?: string;
}
/** Surface focus is currently at the top-level owner. Keep address/key as the selected part context.
 * A shared component has no unique canvas owner; its definition must be opened by the Host. */
export function creativeDesignFocus(
  content: DesignContent,
  value: CreativeDesignAddress,
): CreativeDesignFocus {
  const { address, element, owner } = resolve(content, value);
  return {
    address,
    key: creativeDesignAddressKey(address),
    ...(address.componentId && !address.instanceId
      ? { componentId: address.componentId }
      : { focusElementId: owner?.id ?? element.id }),
  };
}
const supported = new Set([
  'bounds',
  'text',
  'src',
  'fill',
  'opacity',
  'hidden',
  'locked',
  'rotation',
  'flipX',
  'flipY',
  'imageFit',
  'crop',
  'alt',
  'reference',
  'provenance',
]);
/** Creative Design only. The manga/page adapters retain their own subset and fallback rules. */
export const designCreativeProposalDiff: ProposalDiffAdapter<DesignContent> = {
  domain: 'design',
  has(content, id) {
    if (content.elements.some((e) => e.id === id)) return true;
    if (!id.startsWith(prefix)) return false;
    try {
      resolve(content, parseCreativeDesignAddress(id));
      return true;
    } catch {
      return false;
    }
  },
  diff(before, after) {
    const result: DomainDiff = { changes: [], view: [], fallback: [] };
    const fallback = (
      path: string,
      old: unknown,
      next: unknown,
      reason = 'unsupported-creative-property',
    ) => result.fallback.push({ path, before: old, after: next, reason });
    const fields = (
      x: Partial<DesignElement>,
      y: Partial<DesignElement>,
      address: CreativeDesignAddress,
      override = false,
    ) => {
      let key: string;
      try {
        resolve(before, address);
        resolve(after, address);
        key = creativeDesignAddressKey(address);
      } catch (error) {
        fallback(
          creativeDesignAddressKey(address),
          x,
          y,
          error instanceof Error ? error.message : 'unsupported-address',
        );
        return;
      }
      for (const property of changedKeys(x, y)) {
        const old = x[property as keyof DesignElement],
          next = y[property as keyof DesignElement];
        if (!override && property === 'rotation' && (old ?? 0) === (next ?? 0)) continue;
        if (supported.has(property))
          result.changes.push({
            domain: 'design',
            kind: property === 'bounds' ? 'move' : property === 'text' ? 'text' : 'property',
            elementId: key,
            elementLabel: x.name ?? y.name,
            property: override ? `overrides.${property}` : property,
            before: old,
            after: next,
            ...(property === 'bounds' ? { units: 'design-px' } : {}),
          });
        else if (
          property === 'overrides' &&
          !override &&
          !address.componentId &&
          x.type === 'instance' &&
          y.type === 'instance'
        ) {
          for (const partId of changedKeys(x.overrides ?? {}, y.overrides ?? {})) {
            const partAddress = {
              elementId: partId,
              componentId: x.componentId!,
              instanceId: address.elementId,
            };
            if (x.componentId !== y.componentId || !x.componentId)
              fallback(key + '/overrides', x.overrides, y.overrides, 'ambiguous-component');
            else
              fields(x.overrides?.[partId] ?? {}, y.overrides?.[partId] ?? {}, partAddress, true);
          }
        } else
          fallback(
            key + '/' + property,
            old,
            next,
            property === 'overrides' ? 'nested-instance-unsupported' : undefined,
          );
      }
    };
    const elements = (a: DesignElement[], b: DesignElement[], componentId?: string) => {
      for (const id of new Set([...a.map((e) => e.id), ...b.map((e) => e.id)])) {
        const x = a.filter((e) => e.id === id),
          y = b.filter((e) => e.id === id);
        const address = {
          elementId: id,
          ...(componentId ? { componentId } : {}),
        };
        if (x.length !== 1 || y.length !== 1)
          fallback(creativeDesignAddressKey(address), x, y, 'unsupported-creative-structure');
        else if (!sameValue(x[0], y[0])) fields(x[0], y[0], address);
      }
      if (
        !sameValue(
          a.map((e) => e.id),
          b.map((e) => e.id),
        )
      )
        fallback(
          componentId ?? 'elements',
          a.map((e) => e.id),
          b.map((e) => e.id),
          'unsupported-creative-order',
        );
    };
    elements(before.elements, after.elements);
    for (const id of new Set([
      ...before.components.map((c) => c.id),
      ...after.components.map((c) => c.id),
    ])) {
      const a = before.components.filter((c) => c.id === id),
        b = after.components.filter((c) => c.id === id);
      if (a.length !== 1 || b.length !== 1) {
        fallback('components/' + id, a, b, 'unsupported-creative-structure');
        continue;
      }
      for (const property of changedKeys(a[0], b[0], ['elements']))
        fallback(
          'components/' + id + '/' + property,
          a[0][property as keyof (typeof a)[0]],
          b[0][property as keyof (typeof b)[0]],
        );
      if (a[0].elements && b[0].elements) elements(a[0].elements, b[0].elements, id);
      else if (!sameValue(a[0].elements, b[0].elements))
        fallback(
          'components/' + id + '/elements',
          a[0].elements,
          b[0].elements,
          'unsupported-creative-structure',
        );
    }
    const oldOrder = before.components.map((c) => c.id),
      newOrder = after.components.map((c) => c.id);
    if (!sameValue(oldOrder, newOrder))
      fallback('components', oldOrder, newOrder, 'unsupported-creative-order');
    for (const property of changedKeys(before, after, ['elements', 'components']))
      fallback(
        property,
        before[property as keyof DesignContent],
        after[property as keyof DesignContent],
      );
    return result;
  },
};
/** Only source-inheriting instance attribution invalidated by an allowed shared
 * source replacement is derived cleanup. Keep it in the public diff; it neither
 * grants a new edit target nor satisfies a requested instance edit. */
function isDerivedProvenanceCleanup(
  before: DesignContent,
  after: DesignContent,
  key: string,
  diff: DomainDiff,
  allowed: ReadonlySet<string>,
): boolean {
  const address = parseCreativeDesignAddress(key);
  if (!address.instanceId || !address.componentId) return false;
  const changes = diff.changes.filter((change) => change.elementId === key);
  if (
    changes.length !== 1 ||
    changes[0].property !== 'overrides.provenance' ||
    changes[0].after !== undefined
  )
    return false;
  const sharedAddress = {
    componentId: address.componentId,
    elementId: address.elementId,
  };
  const sharedKey = creativeDesignAddressKey(sharedAddress);
  if (
    !allowed.has(sharedKey) ||
    !diff.changes.some((change) => change.elementId === sharedKey && change.property === 'src')
  )
    return false;
  const oldShared = resolve(before, sharedAddress).element,
    newShared = resolve(after, sharedAddress).element;
  if (
    oldShared.type !== 'image' ||
    newShared.type !== 'image' ||
    typeof oldShared.src !== 'string' ||
    !oldShared.src ||
    sameValue(oldShared.src, newShared.src)
  )
    return false;
  const oldPart = resolve(before, address),
    newPart = resolve(after, address);
  if (
    oldPart.element.type !== 'image' ||
    newPart.element.type !== 'image' ||
    oldPart.element.src !== oldShared.src ||
    newPart.element.src !== newShared.src
  )
    return false;
  const oldOverride = oldPart.owner?.overrides?.[address.elementId],
    newOverride = newPart.owner?.overrides?.[address.elementId] ?? {};
  if (
    !oldOverride ||
    Object.hasOwn(oldOverride, 'src') ||
    Object.hasOwn(newOverride, 'src') ||
    Object.hasOwn(newOverride, 'provenance')
  )
    return false;
  const provenance = (oldOverride as Partial<DesignElement> & { provenance?: unknown }).provenance;
  return (
    Object.hasOwn(oldOverride, 'provenance') &&
    !!provenance &&
    typeof provenance === 'object' &&
    !Array.isArray(provenance) &&
    Object.hasOwn(provenance, 'src') &&
    (provenance as { src: unknown }).src === oldShared.src &&
    sameValue(changes[0].before, provenance)
  );
}
function assertScope(
  before: DesignContent,
  after: DesignContent,
  scope: CreativeDesignProposalScope,
) {
  const required = scope.required.map(creativeDesignAddressKey),
    allowed = new Set((scope.allowed ?? scope.required).map(creativeDesignAddressKey));
  if (!required.length || required.some((key) => !allowed.has(key)))
    rejectDesign('creative-scope', 'Required parts must be nonempty and included in allowed parts');
  for (const address of [...scope.required, ...(scope.allowed ?? [])]) resolve(before, address);
  // Creative scope cannot carry page-level attribution updates. Never accept a
  // raw source change with a surviving manga attribution, even if schema-valid.
  for (const image of after.pagination?.images ?? []) {
    const old = before.elements.find((e) => e.id === image.elementId && e.type === 'image'),
      next = after.elements.find((e) => e.id === image.elementId && e.type === 'image');
    if (old && next) {
      const a = appearance(before, old),
        b = appearance(after, next);
      if (a.src !== b.src || !sameValue(a.reference, b.reference))
        rejectDesign(
          'creative-attribution',
          'Image source replacement requires native attribution invalidation',
          image.elementId,
        );
    }
  }
  const diff = designCreativeProposalDiff.diff(before, after);
  if (diff.fallback.length)
    rejectDesign(
      'creative-fallback',
      'Creative Design proposals cannot accept fallback changes',
      diff.fallback[0].path,
    );
  const changed = new Set(diff.changes.map((c) => c.elementId));
  // A derived cleanup is guarded by its allowed shared-source origin, whose
  // deliberate src change remains in this set and passes the normal guard below.
  const deliberate = new Set(
    [...changed].filter((key) => !isDerivedProvenanceCleanup(before, after, key, diff, allowed)),
  );
  if (!deliberate.size || required.some((key) => !deliberate.has(key)))
    rejectDesign('creative-scope', 'The proposal must change every required part');
  if ([...deliberate].some((key) => !allowed.has(key)))
    rejectDesign('creative-scope', 'The proposal changes parts outside its allowed scope');
  for (const key of deliberate) {
    const { element, owner, scope: elements } = resolve(before, parseCreativeDesignAddress(key));
    const stateOnly = diff.changes
      .filter((c) => c.elementId === key)
      .every((c) =>
        ['hidden', 'locked', 'overrides.hidden', 'overrides.locked'].includes(c.property),
      );
    const check = (items: DesignElement[], target: DesignElement, skipSelf: boolean) => {
      if (!skipSelf)
        assertEditable(
          items.map((item) => {
            const effective = appearance(before, item);
            return {
              ...item,
              locked: item.locked || effective.locked,
              hidden: item.hidden || effective.hidden,
            };
          }),
          [target.id],
        );
      const seen = new Set<string>();
      let current: DesignElement | undefined = target;
      while (current && !seen.has(current.id)) {
        const effective = appearance(before, current);
        if (
          (!skipSelf || current.id !== target.id) &&
          (current.locked || current.hidden || effective.locked || effective.hidden)
        )
          rejectDesign(
            'creative-locked',
            'Unlock and show the addressed part and its ancestors before editing',
            key,
          );
        seen.add(current.id);
        current = items.find((e) => e.id === current!.parentId);
      }
    };
    check(elements, element, stateOnly);
    if (owner) check(before.elements, owner, false);
  }
  return diff;
}
/** Same native operations for human and AI. Single-stage parts only; no private command API. */
export function creativeDesignEditCommand(
  address: CreativeDesignAddress,
  patch: Partial<DesignElement>,
): EditorCommand<DesignContent> {
  const ownedAddress = checkedAddress(address),
    ownedPatch = captureDesignData(patch);
  return command('design.creative-edit', 'Edit Creative Design part', (content) => {
    resolve(content, ownedAddress);
    const native = ownedAddress.instanceId
      ? overrideInstance(ownedAddress.instanceId, [ownedAddress.elementId], ownedPatch)
      : ownedAddress.componentId
        ? updateComponentPart(ownedAddress.componentId, ownedAddress.elementId, ownedPatch)
        : patchDesign([ownedAddress.elementId], ownedPatch);
    const next = native.apply(content);
    assertScope(content, next, { required: [ownedAddress] });
    return next;
  });
}
/** Scope acceptance is executable: it runs at preview and again at apply, within the existing history.
 * The Host still owns revision/version checks and its trusted mayEdit callback. */
export function prepareCreativeDesignProposal(
  proposal: ProposedCommands<DesignContent> & { baseLocalRevision: LocalDraftRevision },
  scope: CreativeDesignProposalScope,
  mayEdit: () => boolean = () => true,
): ProposedCommands<DesignContent> {
  if (!proposal.baseLocalRevision)
    rejectDesign('creative-revision', 'Creative Design proposals require baseLocalRevision');
  const revision = proposal.baseLocalRevision;
  if (
    !revision ||
    revision.kind !== 'local-draft' ||
    typeof revision.sessionId !== 'string' ||
    !revision.sessionId ||
    !Number.isSafeInteger(revision.sequence) ||
    revision.sequence < 0
  )
    rejectDesign(
      'creative-revision',
      'Creative Design proposals require a valid baseLocalRevision',
    );
  const ownedScope = captureDesignData(scope);
  const commands = proposal.commands.map((value) => Object.freeze({ ...value }));
  const native = guardDesignCommand(transaction(proposal.summary, commands));
  const guarded = command<DesignContent>(
    'design.creative-proposal',
    proposal.summary,
    (content) => {
      if (!mayEdit()) rejectDesign('creative-read-only', 'Creative Design is read only');
      const before = clone(content),
        next = native.apply(clone(content));
      assertScope(before, next, ownedScope);
      return next;
    },
  );
  return deepFreeze({
    ...proposal,
    baseLocalRevision: clone(proposal.baseLocalRevision),
    commands: [guarded],
  });
}
/** Compose with the existing Host adapter; qualified IDs remain reversible for Host mappings/focus. */
export function createCreativeDesignHostAdapter<T extends EditorHostAdapter<DesignContent>>(
  adapter: T,
) {
  return {
    ...adapter,
    changedElements(before: DesignContent, after: DesignContent) {
      const diff = designCreativeProposalDiff.diff(before, after);
      if (diff.fallback.length)
        rejectDesign(
          'creative-fallback',
          'Creative Design proposals cannot accept fallback changes',
        );
      return [...new Set(diff.changes.map((change) => change.elementId))];
    },
  };
}
