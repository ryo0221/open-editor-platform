import { clone, newId } from '@editor-platform/artifact-core';
import {
  previewProposedCommands,
  transaction,
  sameLocalRevision,
  withCommandReads,
  type EditorCommand,
  type LocalDraftRevision,
  type ProposalPreview,
  type TransformDelta,
} from '@editor-platform/editor-core';
import { record, reuseHash } from '@editor-platform/reuse-core';
import {
  assertDesignContent,
  guardDesignCommand,
  insertElement,
  insertInstance,
  updateElement,
  patchDesign,
  transformElements,
  deleteElements,
  reparentElement,
  overrideInstance,
  resetInstance,
  createComponent,
  updateComponent,
  updateComponentPart,
  type DesignContent,
  type DesignElement,
  type DesignComponent,
  type DesignElementType,
  type DesignPlacement,
  type DesignInsertOptions,
} from './model';
import {
  setDesignInteractions,
  setDesignPrototype,
  diagnoseDesignPrototype,
  type DesignPrototypeDiagnostic,
} from './prototype';
import type { DesignInteraction, DesignPrototype } from './prototype-contract';
import { captureDesignData, designId, rejectDesign } from './command-data';

export type DesignIntent =
  | {
      type: 'insert';
      elementType: Exclude<DesignElementType, 'instance' | 'react'>;
      options?: DesignInsertOptions;
    }
  | { type: 'insert-instance'; componentId: string; options?: DesignPlacement }
  | { type: 'update'; id: string; patch: Partial<Omit<DesignElement, 'id'>> }
  | { type: 'properties'; ids: string[]; patch: Partial<Omit<DesignElement, 'id'>> }
  | { type: 'transform'; ids: string[]; delta: TransformDelta }
  | { type: 'delete'; ids: string[] }
  | { type: 'reparent'; id: string; parentId?: string }
  | {
      type: 'override';
      id: string;
      partId: string | readonly string[];
      patch: Partial<Omit<DesignElement, 'id'>>;
    }
  | { type: 'reset-instance'; id: string }
  | { type: 'create-component'; ids: string[]; componentId?: string }
  | { type: 'update-component'; componentId: string; patch: Partial<DesignComponent['template']> }
  | {
      type: 'update-component-part';
      componentId: string;
      partId: string;
      patch: Partial<Omit<DesignElement, 'id'>>;
    }
  | {
      type: 'set-interactions';
      id: string;
      interactions: DesignInteraction[] | null;
      partId?: string;
      definition?: boolean;
    }
  | { type: 'set-prototype'; settings: DesignPrototype | null };

function fields(raw: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (
    required.some((k) => !Object.hasOwn(raw, k)) ||
    Object.keys(raw).some((k) => ![...required, ...optional].includes(k))
  )
    rejectDesign('design-intent', 'Missing or unsupported Design intent field');
}
function placement(value: unknown, image: boolean): DesignInsertOptions {
  if (value === undefined) return { id: newId('design') };
  if (!record(value)) rejectDesign('design-placement', 'Expected Design insertion options');
  fields(value, [], ['id', 'bounds', 'parentId', 'index', ...(image ? ['src'] : [])]);
  if (value.id !== undefined) designId(value.id);
  if (value.parentId !== undefined) designId(value.parentId, 'parentId');
  if (value.index !== undefined && (!Number.isSafeInteger(value.index) || Number(value.index) < 0))
    rejectDesign('design-index', 'Expected a nonnegative insertion index');
  if (value.bounds !== undefined) {
    if (!record(value.bounds)) rejectDesign('design-bounds', 'Expected Design bounds');
    fields(value.bounds, ['x', 'y', 'width', 'height']);
    if (
      !Object.values(value.bounds).every((v) => typeof v === 'number' && Number.isFinite(v)) ||
      Number(value.bounds.width) < 1 ||
      Number(value.bounds.height) < 1
    )
      rejectDesign('design-bounds', 'Invalid Design insertion bounds');
  }
  return { ...value, id: value.id ?? newId('design') } as DesignInsertOptions;
}
type RawIntent = Record<string, unknown>;
/** Required and optional fields per intent type, then type-specific normalization. */
const intentShapes: Record<string, [string[], string[]?, ((raw: RawIntent) => void)?]> = {
  insert: [
    ['type', 'elementType'],
    ['options'],
    (raw) => {
      if (
        !['frame', 'rectangle', 'text', 'image', 'group', 'shape'].includes(String(raw.elementType))
      )
        rejectDesign('design-type', 'Unsupported Design insertion type');
      raw.options = placement(raw.options, true);
    },
  ],
  'insert-instance': [
    ['type', 'componentId'],
    ['options'],
    (raw) => {
      raw.options = placement(raw.options, false);
    },
  ],
  update: [['type', 'id', 'patch']],
  properties: [['type', 'ids', 'patch']],
  transform: [
    ['type', 'ids', 'delta'],
    [],
    (raw) => {
      if (!record(raw.delta)) rejectDesign('design-intent', 'Expected a Design transform delta');
      fields(raw.delta, ['dx', 'dy', 'dw', 'dh'], ['rotation']);
      if (!Object.values(raw.delta).every((v) => typeof v === 'number' && Number.isFinite(v)))
        rejectDesign('design-intent', 'Invalid Design transform delta');
    },
  ],
  delete: [['type', 'ids']],
  reparent: [['type', 'id'], ['parentId']],
  override: [['type', 'id', 'partId', 'patch']],
  'reset-instance': [['type', 'id']],
  'create-component': [
    ['type', 'ids'],
    ['componentId'],
    (raw) => {
      if (raw.componentId === undefined) raw.componentId = newId('component');
    },
  ],
  'update-component': [['type', 'componentId', 'patch']],
  'update-component-part': [['type', 'componentId', 'partId', 'patch']],
  'set-interactions': [
    ['type', 'id', 'interactions'],
    ['partId', 'definition'],
    (raw) => {
      if (raw.definition !== undefined && typeof raw.definition !== 'boolean')
        rejectDesign('design-intent', 'Expected a definition flag');
      if (raw.definition && raw.partId === undefined)
        rejectDesign('design-intent', 'Definition interaction edits require a part ID');
    },
  ],
  'set-prototype': [['type', 'settings']],
};
/** Target IDs shared by every intent type: element/component/parent, part path and ID lists. */
function assertIntentTargets(raw: RawIntent) {
  for (const key of ['id', 'componentId', 'parentId'])
    if (raw[key] !== undefined) designId(raw[key], key);
  if (raw.type === 'override' && Array.isArray(raw.partId)) {
    if (!raw.partId.length || raw.partId.length > 16)
      rejectDesign('design-target', 'Expected 1–16 component part IDs', 'partId');
    raw.partId.forEach((id) => designId(id, 'partId'));
  } else if (raw.partId !== undefined) designId(raw.partId, 'partId');
  if ('ids' in raw) {
    if (
      !Array.isArray(raw.ids) ||
      !raw.ids.length ||
      raw.ids.length > 1000 ||
      new Set(raw.ids).size !== raw.ids.length
    )
      rejectDesign('design-intent', 'Expected unique Design target IDs');
    raw.ids.forEach((id) => designId(id));
  }
  if ('patch' in raw && !record(raw.patch))
    rejectDesign('design-patch', 'Expected a Design patch object');
}
function parseDesignIntent(value: unknown, index: number): DesignIntent {
  if (!record(value) || typeof value.type !== 'string')
    rejectDesign('design-intent', 'Invalid Design intent', String(index));
  const raw: RawIntent = { ...value };
  const shape = Object.hasOwn(intentShapes, value.type) ? intentShapes[value.type] : undefined;
  if (!shape) rejectDesign('design-intent', 'Unsupported Design intent type');
  const [required, optional, normalize] = shape;
  fields(raw, required, optional);
  normalize?.(raw);
  assertIntentTargets(raw);
  return raw as unknown as DesignIntent;
}
/** Parsed JSON only; generated insertion/component IDs are retained in the result. */
export function parseDesignIntents(value: unknown): DesignIntent[] {
  const input = captureDesignData(value, true);
  if (!Array.isArray(input) || !input.length || input.length > 1000)
    rejectDesign('design-limit', 'Expected a Design intent batch of 1..1000 operations');
  return captureDesignData(input.map(parseDesignIntent), true);
}
function nativeCommand(intent: DesignIntent): EditorCommand<DesignContent> {
  switch (intent.type) {
    case 'insert':
      return insertElement(intent.elementType, intent.options);
    case 'insert-instance':
      return insertInstance(intent.componentId, intent.options);
    case 'update':
      return updateElement(intent.id, intent.patch);
    case 'properties':
      return patchDesign(intent.ids, intent.patch);
    case 'transform':
      return transformElements(intent.ids, intent.delta);
    case 'delete':
      return deleteElements(intent.ids);
    case 'reparent':
      return reparentElement(intent.id, intent.parentId);
    case 'override':
      return overrideInstance(intent.id, intent.partId, intent.patch);
    case 'reset-instance':
      return resetInstance(intent.id);
    case 'create-component':
      return createComponent(intent.ids, intent.componentId);
    case 'update-component':
      return updateComponent(intent.componentId, intent.patch);
    case 'update-component-part':
      return updateComponentPart(intent.componentId, intent.partId, intent.patch);
    case 'set-interactions':
      return setDesignInteractions(
        intent.id,
        intent.interactions ?? undefined,
        intent.partId,
        intent.definition,
      );
    case 'set-prototype':
      return setDesignPrototype(intent.settings ?? undefined);
  }
}
function compiledCommand(intents: DesignIntent[], summary: string): EditorCommand<DesignContent> {
  const commands = intents.map((intent) => {
    const value = nativeCommand(intent);
    return {
      ...value,
      apply(content: DesignContent) {
        const ids = 'ids' in intent ? intent.ids : 'id' in intent ? [intent.id] : [];
        if (ids.some((id) => !content.elements.some((e) => e.id === id)))
          rejectDesign('design-target', 'Design intent target no longer exists');
        return value.apply(content);
      },
    };
  });
  return withCommandReads(guardDesignCommand(transaction(summary, commands)), { content: ['*'] });
}
export function designIntentCommand(
  value: unknown,
  summary = 'Apply Design intents',
): EditorCommand<DesignContent> {
  return compiledCommand(parseDesignIntents(value), summary);
}
/** Portable data retained by a Host; the functions in ProposedCommands never cross JSON. */
export interface DesignIntentProposal {
  schemaVersion: 1;
  id: string;
  summary: string;
  baseContentHash: string;
  resultContentHash: string;
  baseLocalRevision?: LocalDraftRevision;
  intents: DesignIntent[];
}
export interface DesignIntentPreview extends ProposalPreview<DesignContent> {
  intentProposal: DesignIntentProposal;
  diagnostics: DesignPrototypeDiagnostic[];
}
export function previewDesignIntents(
  content: DesignContent,
  value: unknown,
  options: { summary?: string; baseLocalRevision?: LocalDraftRevision } = {},
): DesignIntentPreview {
  const base = captureDesignData(content);
  assertDesignContent(base);
  const intents = parseDesignIntents(value);
  const summary = options.summary ?? 'Apply Design intents';
  const proposalId = newId('design-proposal');
  const preview = previewProposedCommands(base, {
    id: proposalId,
    summary,
    baseLocalRevision: options.baseLocalRevision,
    commands: [compiledCommand(intents, summary)],
  });
  const proposal: DesignIntentProposal = {
    schemaVersion: 1,
    id: proposalId,
    summary,
    baseContentHash: reuseHash(base),
    resultContentHash: reuseHash(preview.content),
    intents,
    ...(options.baseLocalRevision === undefined
      ? {}
      : { baseLocalRevision: clone(options.baseLocalRevision) }),
  };
  return {
    ...preview,
    intentProposal: captureDesignData(proposal, true),
    diagnostics: diagnoseDesignPrototype(preview.content),
  };
}
/** Execute this command through the existing Host Session/authority, never a parallel history. */
export function prepareDesignIntentApplication(
  value: DesignIntentProposal,
  options: { writable?: () => boolean; readRevision?: () => LocalDraftRevision } = {},
): EditorCommand<DesignContent> {
  const proposal = captureDesignData(value, true);
  if (!record(proposal))
    rejectDesign('design-proposal', 'Expected a portable Design intent proposal');
  fields(
    proposal,
    ['schemaVersion', 'id', 'summary', 'baseContentHash', 'resultContentHash', 'intents'],
    ['baseLocalRevision'],
  );
  if (
    proposal.schemaVersion !== 1 ||
    typeof proposal.summary !== 'string' ||
    proposal.summary.length > 4096 ||
    typeof proposal.baseContentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proposal.baseContentHash) ||
    typeof proposal.resultContentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proposal.resultContentHash)
  )
    rejectDesign('design-proposal', 'Invalid Design intent proposal');
  designId(proposal.id);
  if (proposal.baseLocalRevision !== undefined) {
    const revision = proposal.baseLocalRevision;
    if (
      !record(revision) ||
      revision.kind !== 'local-draft' ||
      typeof revision.sessionId !== 'string' ||
      !Number.isSafeInteger(revision.sequence) ||
      revision.sequence < 0
    )
      rejectDesign('design-proposal', 'Invalid Design proposal revision');
  }
  const valueCommand = compiledCommand(parseDesignIntents(proposal.intents), proposal.summary);
  const readRevision = options.readRevision;
  return guardDesignCommand(
    {
      ...valueCommand,
      context: { origin: 'proposal', transactionId: newId('transaction'), proposalId: proposal.id },
      apply(current) {
        if (
          proposal.baseLocalRevision &&
          (!readRevision || !sameLocalRevision(proposal.baseLocalRevision, readRevision()))
        )
          rejectDesign('design-stale', 'Design proposal revision is stale');
        if (reuseHash(captureDesignData(current)) !== proposal.baseContentHash)
          rejectDesign('design-stale', 'Design proposal content has changed');
        const next = valueCommand.apply(current);
        if (reuseHash(next) !== proposal.resultContentHash)
          rejectDesign('design-proposal-result', 'Design proposal no longer matches its preview');
        return next;
      },
    },
    options.writable,
  );
}
