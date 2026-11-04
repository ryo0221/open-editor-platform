import {
  canonicalJson,
  checkProposalReads,
  clone,
  deepFreeze,
  newId,
  validProposalReads,
  type CurrentRead,
  type ProposalReads,
} from '@editor-platform/artifact-core';
import {
  command,
  descendantIds,
  sameLocalRevision,
  withCommandReads,
  type Bounds,
  type LocalDraftRevision,
  type ProposedCommands,
  type EditorCommand,
} from '@editor-platform/editor-core';
import { captureDesignData, designId } from './command-data';
import { appearance, assertDesignContent, type DesignContent } from './model';
import { designPageEditCommand, setDesignPagination } from './pagination';
import { designMangaProposalDiff as designPageProposalDiff } from './manga-proposal-diff';
import {
  designDivisionCommand,
  parseDivisionOperation,
  type DesignDivisionOperation,
} from './division';

export type DesignPageOperation =
  | DesignDivisionOperation
  | { type: 'bounds'; id: string; value: Bounds }
  | { type: 'text'; id: string; value: string }
  | { type: 'image'; id: string; value: { src: string; source: string; license: string } }
  | { type: 'pageOrder'; before: string[]; after: string[] }
  | { type: 'panelOrder'; pageId: string; before: string[]; after: string[] };
export interface DesignPageProposalUnit {
  id: string;
  label: string;
  requires: string[];
  operations: DesignPageOperation[];
}
/** Data only. The Host supplies AI execution and records the versions it read. */
export interface DesignPageProposalRequest {
  id: string;
  summary: string;
  artifactId: string;
  baseLocalRevision: LocalDraftRevision;
  reads: ProposalReads;
  units: DesignPageProposalUnit[];
}
export interface DesignPageProposalContext {
  artifactId: string;
  versionId: string | null;
  revision: LocalDraftRevision;
  content: DesignContent;
  readOnly: boolean;
  readReference?: (artifactId: string) => CurrentRead | undefined;
}
export interface PreparedDesignPageProposal {
  request: DesignPageProposalRequest;
  selectedUnitIds: readonly string[];
  proposal: ProposedCommands<DesignContent>;
  before: DesignContent;
  after: DesignContent;
  diff: ReturnType<typeof designPageProposalDiff.diff>;
}
const preparedPlans = new WeakSet<object>();
const preparedCommands = new WeakSet<object>();
/** Host gates can recognize the validated boundary without trusting a caller-supplied type string. */
export const isPreparedDesignPageCommand = (value: unknown): boolean =>
  !!value && typeof value === 'object' && preparedCommands.has(value);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
function ids(v: unknown, max: number): asserts v is string[] {
  if (!Array.isArray(v) || v.length > max || new Set(v).size !== v.length)
    throw Error('Expected unique bounded IDs');
  v.forEach((id) => designId(id));
}
const orderKey = (op: DesignPageOperation) =>
  op.type === 'pageOrder' ? 'pages' : op.type === 'panelOrder' ? `panels:${op.pageId}` : '*';
function operation(raw: unknown): asserts raw is DesignPageOperation {
  if (!raw || typeof raw !== 'object') throw Error('Invalid page operation');
  const op = raw as DesignPageOperation;
  if (op.type === 'pageOrder' || op.type === 'panelOrder') {
    if (
      !fields(
        op,
        op.type === 'pageOrder'
          ? ['type', 'before', 'after']
          : ['type', 'pageId', 'before', 'after'],
      )
    )
      throw Error('Unsupported reading order fields');
    if (op.type === 'panelOrder') designId(op.pageId);
    const max = op.type === 'pageOrder' ? 128 : 64;
    ids(op.before, max);
    ids(op.after, max);
    if (op.before.length !== op.after.length || op.after.some((id) => !op.before.includes(id)))
      throw Error('Reading order must preserve membership');
  } else if (isDivisionOperation(op)) {
    parseDivisionOperation(op);
  } else {
    // Keeps the original M0 adapter narrow, including rejection of path operations.
    designPageEditCommand([op]);
  }
}
export function readDesignPageProposal(raw: unknown): DesignPageProposalRequest {
  const value = captureDesignData(raw, true);
  if (!fields(value, ['id', 'summary', 'artifactId', 'baseLocalRevision', 'reads', 'units']))
    throw Error('Unsupported page proposal fields');
  designId(value.id);
  designId(value.artifactId);
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 1000)
    throw Error('Expected a bounded proposal summary');
  const r = value.baseLocalRevision;
  if (
    !fields(r, ['kind', 'sessionId', 'sequence']) ||
    r.kind !== 'local-draft' ||
    typeof r.sequence !== 'number' ||
    !Number.isSafeInteger(r.sequence) ||
    r.sequence < 0
  )
    throw Error('Invalid proposal revision');
  designId(r.sessionId);
  if (!validProposalReads(value.reads) || value.reads.target.artifactId !== value.artifactId)
    throw Error('Invalid proposal read versions');
  if (
    !fields(value.reads, ['target', 'references']) ||
    !fields(value.reads.target, ['artifactId', 'versionId']) ||
    value.reads.references.some((ref) => !fields(ref, ['artifactId', 'versionId']))
  )
    throw Error('Unsupported proposal read fields');
  if (!Array.isArray(value.units) || !value.units.length || value.units.length > 32)
    throw Error('Expected 1–32 proposal units');
  let count = 0;
  for (const unit of value.units) {
    if (!fields(unit, ['id', 'label', 'requires', 'operations']))
      throw Error('Invalid proposal unit');
    designId(unit.id);
    if (typeof unit.label !== 'string' || !unit.label.trim() || unit.label.length > 500)
      throw Error('Expected a bounded unit label');
    ids(unit.requires, 31);
    if (
      !Array.isArray(unit.operations) ||
      !unit.operations.length ||
      (count += unit.operations.length) > 100
    )
      throw Error('Expected 1–100 page operations');
    unit.operations.forEach(operation);
  }
  const request = value as unknown as DesignPageProposalRequest;
  ids(
    request.units.map((u) => u.id),
    32,
  );
  const byId = new Map(request.units.map((u) => [u.id, u]));
  const visiting = new Set<string>();
  const dependencies = new Map<string, Set<string>>();
  function visit(id: string): Set<string> {
    if (dependencies.has(id)) return dependencies.get(id)!;
    const unit = byId.get(id);
    if (!unit || visiting.has(id)) throw Error('Missing or cyclic proposal dependency');
    visiting.add(id);
    const result = new Set<string>();
    for (const parent of unit.requires) {
      result.add(parent);
      visit(parent).forEach((p) => result.add(p));
    }
    visiting.delete(id);
    dependencies.set(id, result);
    return result;
  }
  request.units.forEach((u) => visit(u.id));
  for (let i = 0; i < request.units.length; i++)
    for (let j = i + 1; j < request.units.length; j++) {
      const a = request.units[i],
        b = request.units[j];
      const overlap = a.operations.some((x) =>
        b.operations.some(
          (y) => orderKey(x) === '*' || orderKey(y) === '*' || orderKey(x) === orderKey(y),
        ),
      );
      if (overlap && !dependencies.get(a.id)!.has(b.id) && !dependencies.get(b.id)!.has(a.id))
        throw Error(`Overlapping units require an explicit dependency: ${a.id}, ${b.id}`);
    }
  return request;
}
function fresh(request: DesignPageProposalRequest, current: DesignPageProposalContext) {
  if (current.readOnly) throw Error('Page proposals require a writable local artifact');
  if (
    request.artifactId !== current.artifactId ||
    !sameLocalRevision(request.baseLocalRevision, current.revision)
  )
    throw Error('The draft changed. Request new page proposals.');
  const check = checkProposalReads(request.reads, (id) =>
    id === current.artifactId
      ? { status: 'available', versionId: current.versionId }
      : current.readReference?.(id),
  );
  if (!check.fresh)
    throw Error('A proposal source changed or is unavailable. Request new page proposals.');
}
function isDivisionOperation(op: DesignPageOperation): op is DesignDivisionOperation {
  return ['startDivision', 'splitPanel', 'setDivider', 'mergePanels', 'detachDivision'].includes(
    op.type,
  );
}
function applyOperation(d: DesignContent, op: DesignPageOperation): DesignContent {
  if (isDivisionOperation(op)) return designDivisionCommand(op).apply(d);
  const targets =
    op.type === 'pageOrder'
      ? op.before
      : op.type === 'panelOrder'
        ? [op.pageId, ...op.before]
        : op.type === 'bounds'
          ? [...descendantIds(d.elements, [op.id])]
          : [op.id];
  for (const id of targets) {
    let element = d.elements.find((e) => e.id === id);
    if (!element) throw Error('Missing page proposal target');
    while (element) {
      const effective = appearance(d, element);
      if (element.hidden || element.locked || effective.hidden || effective.locked)
        throw Error('Unlock and show proposal targets and their ancestors first');
      element = d.elements.find((e) => e.id === element!.parentId);
    }
  }
  if (op.type !== 'pageOrder' && op.type !== 'panelOrder') {
    const next = designPageEditCommand([op]).apply(d);
    if (op.type === 'bounds') {
      const page = next.pagination?.pages.find((p) => p.panelIds.includes(op.id));
      if (page) {
        const p = next.elements.find((e) => e.id === page.frameId)!.bounds,
          b = op.value;
        if (
          b.x < p.x ||
          b.y < p.y ||
          b.x + b.width > p.x + p.width ||
          b.y + b.height > p.y + p.height
        )
          throw Error(
            'A proposed panel must fit within its page; cross-page panels are unsupported',
          );
      }
    }
    return next;
  }
  const p = d.pagination;
  if (!p) throw Error('Page reading order is missing');
  const before =
    op.type === 'pageOrder'
      ? p.pages.map((x) => x.frameId)
      : p.pages.find((x) => x.frameId === op.pageId)?.panelIds;
  if (canonicalJson(before ?? null) !== canonicalJson(op.before))
    throw Error('Reading order changed or page is missing');
  const pages =
    op.type === 'pageOrder'
      ? op.after.map((id) => p.pages.find((page) => page.frameId === id)!)
      : p.pages.map((page) =>
          page.frameId === op.pageId ? { ...page, panelIds: [...op.after] } : page,
        );
  return setDesignPagination({ ...p, pages }).apply(d);
}
/** Produces a NEW whole proposal for the chosen dependency-closed set; never mutates a draft. */
export function prepareDesignPageProposal(
  current: DesignPageProposalContext,
  raw: unknown,
  selectedUnitIds: readonly string[],
  proposalId: string,
): PreparedDesignPageProposal {
  const request = readDesignPageProposal(raw);
  fresh(request, current);
  designId(proposalId);
  if (proposalId === request.id) throw Error('Selected changes need a new proposal ID');
  const selected = captureDesignData(selectedUnitIds, true) as string[];
  ids(selected, 32);
  if (!selected.length) throw Error('Select at least one change');
  const units = new Map(request.units.map((u) => [u.id, u]));
  for (const id of selected) {
    const u = units.get(id);
    if (!u) throw Error('Unknown selected unit');
    const missing = u.requires.filter((p) => !selected.includes(p));
    if (missing.length) throw Error(`Select required changes first: ${missing.join(', ')}`);
  }
  const operations: DesignPageOperation[] = [],
    done = new Set<string>();
  function append(id: string) {
    if (done.has(id)) return;
    const u = units.get(id)!;
    u.requires.forEach(append);
    done.add(id);
    operations.push(...u.operations);
  }
  request.units.filter((u) => selected.includes(u.id)).forEach((u) => append(u.id));
  const before = captureDesignData(current.content);
  assertDesignContent(before);
  let after = clone(before);
  for (const op of operations) after = applyOperation(after, op);
  assertDesignContent(after);
  const diff = designPageProposalDiff.diff(before, after);
  if (diff.fallback.length) throw Error('Selected changes exceed the page proposal subset');
  if (!diff.changes.length) throw Error('Selected changes do not change the page');
  const basis = canonicalJson(before),
    result = canonicalJson(after);
  const apply = withCommandReads(
    command<DesignContent>('design.page.proposal', request.summary, (d) => {
      if (canonicalJson(d) !== basis) throw Error('The draft changed after page preview');
      let next = d;
      for (const op of operations) next = applyOperation(next, op);
      assertDesignContent(next);
      if (canonicalJson(next) !== result)
        throw Error('Page changes differ from the reviewed result');
      return next;
    }),
    { content: ['*'] },
  );
  const plan = deepFreeze({
    request,
    selectedUnitIds: selected,
    before,
    after,
    diff,
    proposal: {
      id: proposalId,
      summary: request.summary,
      baseLocalRevision: request.baseLocalRevision,
      reads: request.reads,
      commands: [apply],
    },
  });
  preparedPlans.add(plan);
  return plan;
}
/** Call after flushing inputs, at the trusted submission boundary, including reference access. */
export function checkDesignPageProposal(
  plan: PreparedDesignPageProposal,
  current: DesignPageProposalContext,
): void {
  if (!preparedPlans.has(plan)) throw Error('Unknown page proposal plan');
  fresh(plan.request, current);
  if (canonicalJson(current.content) !== canonicalJson(plan.before))
    throw Error('The page preview is stale');
}
/** Rechecks live authority/references inside native preview AND execution. Hosts flush inputs first. */
export function designPageProposalCommand(
  plan: PreparedDesignPageProposal,
  current: () => DesignPageProposalContext,
): EditorCommand<DesignContent> {
  checkDesignPageProposal(plan, current());
  const result = Object.freeze(
    withCommandReads<DesignContent>(
      command(
        'design.page.proposal',
        plan.proposal.summary,
        (d) => {
          checkDesignPageProposal(plan, current());
          return plan.proposal.commands[0].apply(d);
        },
        { origin: 'proposal', transactionId: newId('transaction'), proposalId: plan.proposal.id },
      ),
      { content: ['*'] },
    ),
  );
  preparedCommands.add(result);
  return result;
}
