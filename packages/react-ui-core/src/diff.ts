import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { loadReactUiDocument } from './document';
import { readReactRegistrationCandidates } from './proposal';
import { schemaAssignable } from './schema';
import type { ReactUiDocument, RegisteredReactComponent, JsonValue } from './types';

export interface ReactCompositionChange {
  kind:
    | 'node-added'
    | 'node-removed'
    | 'component'
    | 'prop'
    | 'binding'
    | 'layout'
    | 'slot'
    | 'roots'
    | 'environment'
    | 'input'
    | 'callback'
    | 'fixture'
    | 'breakpoints'
    | 'registration';
  nodeId?: string;
  field?: string;
  before?: JsonValue;
  after?: JsonValue;
}
const equal = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
const keys = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
/** Stable-ID observations only. Never executable operations or permission attestations. */
export function diffReactUiComposition(before: unknown, after: unknown) {
  const a = loadReactUiDocument(before),
    b = loadReactUiDocument(after);
  const changes: ReactCompositionChange[] = [];
  const add = (
    kind: ReactCompositionChange['kind'],
    old: unknown,
    next: unknown,
    nodeId?: string,
    field?: string,
  ) => {
    if (equal(old, next)) return;
    changes.push({
      kind,
      ...(nodeId ? { nodeId } : {}),
      ...(field ? { field } : {}),
      ...(old !== undefined ? { before: old as JsonValue } : {}),
      ...(next !== undefined ? { after: next as JsonValue } : {}),
    });
  };
  const am = new Map(a.nodes.map((n) => [n.id, n])),
    bm = new Map(b.nodes.map((n) => [n.id, n]));
  for (const id of [...new Set([...am.keys(), ...bm.keys()])].sort()) {
    const old = am.get(id),
      next = bm.get(id);
    if (!old || !next) {
      add(old ? 'node-removed' : 'node-added', old, next, id);
      continue;
    }
    add('component', old.component, next.component, id);
    for (const [map, kind] of [
      ['props', 'prop'],
      ['bindings', 'binding'],
      ['slots', 'slot'],
    ] as const)
      for (const field of keys(old[map], next[map]))
        add(kind, old[map][field], next[map][field], id, field);
    for (const field of keys(old.layout.base, next.layout.base))
      add(
        'layout',
        old.layout.base[field as keyof typeof old.layout.base],
        next.layout.base[field as keyof typeof next.layout.base],
        id,
        'base.' + field,
      );
    for (const bp of keys(old.layout.breakpoints, next.layout.breakpoints)) {
      const x = old.layout.breakpoints[bp] ?? {},
        y = next.layout.breakpoints[bp] ?? {};
      for (const field of keys(x, y))
        add('layout', x[field as keyof typeof x], y[field as keyof typeof y], id, bp + '.' + field);
    }
  }
  add('roots', a.roots, b.roots);
  add('environment', a.environment, b.environment);
  add('breakpoints', a.breakpoints, b.breakpoints);
  for (const [map, kind] of [
    ['inputs', 'input'],
    ['callbacks', 'callback'],
    ['fixture', 'fixture'],
  ] as const)
    for (const field of keys(a[map], b[map]))
      add(kind, a[map][field], b[map][field], undefined, field);
  const componentMap = (d: ReactUiDocument) =>
    Object.fromEntries(
      d.components.map((c) => [
        JSON.stringify([c.ref.registryId, c.ref.componentId, c.ref.version]),
        c,
      ]),
    );
  const ac = componentMap(a),
    bc = componentMap(b);
  for (const field of keys(ac, bc)) add('registration', ac[field], bc[field], undefined, field);
  return deepFreeze({ beforeFingerprint: reuseHash(a), afterFingerprint: reuseHash(b), changes });
}

export interface ReactRegistrationDifference {
  identity: { registryId: string; componentId: string };
  kind: 'added' | 'removed' | 'changed';
  breaking: boolean;
  reasons: string[];
  before?: RegisteredReactComponent;
  after?: RegisteredReactComponent;
}
/** One explicitly selected version per identity in each snapshot; never guesses latest. */
export function diffReactRegistrationCandidates(before: unknown, after: unknown) {
  const a = readReactRegistrationCandidates(before),
    b = readReactRegistrationCandidates(after);
  if (a.diagnostics.length || b.diagnostics.length)
    throw Error('Resolve registration candidate diagnostics before comparison');
  const map = (input: typeof a) => {
    const result = new Map<string, RegisteredReactComponent>();
    for (const c of input.candidates) {
      const key = JSON.stringify([c.proposed.ref.registryId, c.proposed.ref.componentId]);
      if (result.has(key))
        throw Error('Select one exact version per component identity before comparison');
      result.set(key, c.proposed);
    }
    return result;
  };
  const am = map(a),
    bm = map(b),
    changes: ReactRegistrationDifference[] = [];
  for (const key of [...new Set([...am.keys(), ...bm.keys()])].sort()) {
    const old = am.get(key),
      next = bm.get(key);
    if (equal(old, next)) continue;
    const reasons: string[] = [];
    if (!next) reasons.push('component-removed');
    if (old && next) {
      if (old.ref.version === next.ref.version) reasons.push('immutable-version-rewritten');
      if (old.ref.implementationHash !== next.ref.implementationHash)
        reasons.push('implementation-changed:review-required');
      if (!equal(old.import, next.import)) reasons.push('import-changed');
      if (old.layout !== next.layout) reasons.push('layout-changed');
      if (!equal(old.requires, next.requires)) reasons.push('dependencies-changed');
      if (!equal(old.controlledInputs, next.controlledInputs))
        reasons.push('controlled-input-changed');
      for (const prop of keys(old.props, next.props)) {
        const x = old.props[prop],
          y = next.props[prop];
        if (x && !y) reasons.push('prop-removed:' + prop);
        else if (y && (!x || !x.required) && y.required && !Object.hasOwn(y, 'default'))
          reasons.push('prop-required:' + prop);
        if (x && y && !schemaAssignable(x.schema, y.schema)) reasons.push('prop-narrowed:' + prop);
        if (x && y && !equal(x.default, y.default)) reasons.push('default-changed:' + prop);
      }
      for (const event of keys(old.events, next.events))
        if (!equal(old.events[event], next.events[event])) reasons.push('event-changed:' + event);
      for (const slot of keys(old.slots, next.slots))
        if (!equal(old.slots[slot], next.slots[slot])) reasons.push('slot-changed:' + slot);
    }
    const identity = (next ?? old)!.ref;
    changes.push({
      identity: { registryId: identity.registryId, componentId: identity.componentId },
      kind: !old ? 'added' : !next ? 'removed' : 'changed',
      breaking: reasons.length > 0,
      reasons,
      ...(old ? { before: old } : {}),
      ...(next ? { after: next } : {}),
    });
  }
  return deepFreeze({
    beforeSourceRevision: a.sourceRevision,
    afterSourceRevision: b.sourceRevision,
    changes,
  });
}
