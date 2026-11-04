/** Host-only read contexts: immutable saved tables and explicitly identified candidates.
 * Candidate IDs are never version IDs and are never persisted as native references. */
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { sameLocalRevision, type LocalDraftRevision } from '@editor-platform/editor-core';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import { isDocument } from '@editor-platform/document/model';
import { readTimelineTable, type TimelineRole, type TimelineRow, type TimelineRef } from './table';
import type { TimelineWorkbench } from './workbench';
import type { CreativeWorkspaceLinksV2 } from '../workspace/model';
import { TL1_LIMITS } from './tl1-schema';
import { verifyNewReferences } from './refs';
export const TIMELINE_DEPENDENCY_RULES = 'tl-deps/1';
export const TIMELINE_DIAGNOSTIC_RULES = 'tl-diagnostics/1';
export type Exact = Extract<TimelineRef, { type: 'exact' }>;
export interface TimelineCandidate {
  id: string;
  owner: string;
  base: string;
  baseHash: string;
  content: StructuredData;
  payloadHash: string;
  localRevision?: LocalDraftRevision;
}
export interface TimelineSubstitution {
  source: string;
  owner: string;
  base: string;
  selector: { row: string; ref: 'ref' | 'ref2' };
  expectOld: Exact;
  to: { candidate: string; item: string };
}
export interface TimelineAnalysisScope {
  kind: 'all' | 'information-use';
  targets: string[];
}
export interface TimelineAnalysisRequest {
  /** Host-authored reading of a cited statement, never inferred from prose or saved as a new content model. */
  disclosureEvidence?: {
    occurrence: string;
    source: Exact;
    mode: 'confirmed' | 'partial' | 'misleading';
  }[];
  candidates?: TimelineCandidate[];
  substitutions?: TimelineSubstitution[];
  roots?: Record<string, string>;
  scope?: TimelineAnalysisScope;
  dependencyRules?: string;
  diagnosticRules?: string;
  readingPremise?: unknown;
  shared?: boolean;
}
/** Keep the same semantic premises while reading only adopted owners. */
export function adoptedAnalysisRequest(input: TimelineAnalysisRequest): TimelineAnalysisRequest {
  const common = { ...input };
  delete common.candidates;
  delete common.roots;
  delete common.substitutions;
  return common;
}
export interface AnalysisTable {
  key: string;
  owner: string;
  role: TimelineRole;
  version: string;
  hash: string;
  rows: TimelineRow[];
  candidate?: string;
}
export interface AnalysisNode {
  table: AnalysisTable;
  row: TimelineRow;
}
export function exactOf(node: AnalysisNode): Exact {
  return {
    type: 'exact',
    artifact: node.table.owner,
    version: node.table.version,
    hash: node.table.hash,
    item: node.row.id,
  };
}
export const nodeKey = (node: AnalysisNode) => `${node.table.key}#${node.row.id}`;
export const siteKey = (node: AnalysisNode) => `${node.table.owner}#${node.row.id}`;
const rolesOf = (links: CreativeWorkspaceLinksV2): Map<string, TimelineRole> =>
  new Map([
    [links.story.worldSettings, 'world'],
    [links.story.composition, 'composition'],
    ...links.story.ledgers.map((l) => [l.artifactId, 'ledger'] as const),
    ...links.story.sceneCards.map((id) => [id, 'scene-cards'] as const),
  ]);
export async function captureTimelineCandidate(
  w: TimelineWorkbench,
  owner: string,
  id: string,
  virtual = false,
): Promise<TimelineCandidate> {
  const o = w.owner(owner);
  if (!o) throw Error('候補の資料を読めません。');
  const access = w.captureAccess(owner),
    revision = o.editor.revision;
  const version = o.editor.artifact.versions.find(
    (v) => v.versionId === o.editor.artifact.draft.baseVersionId,
  );
  if (!version) throw Error('基準の保存版がありません。');
  const content = structuredClone(virtual ? version.content : o.editor.content);
  const payloadHash = await contentHash(content);
  if (!access() || (!virtual && !sameLocalRevision(revision, o.editor.revision)))
    throw Error('候補が変わりました。');
  return {
    id,
    owner,
    base: version.versionId,
    baseHash: version.contentHash,
    content,
    payloadHash,
    ...(virtual ? {} : { localRevision: revision }),
  };
}
export class TimelineAnalysisContext {
  readonly links: CreativeWorkspaceLinksV2;
  readonly request: TimelineAnalysisRequest;
  readonly roles: Map<string, TimelineRole>;
  readonly roots = new Map<string, AnalysisTable>();
  readonly candidates = new Map<string, AnalysisTable>();
  readonly tables = new Map<string, AnalysisTable>();
  readonly guards: (() => boolean)[] = [];
  readonly adopted = new Map<string, { version: string; hash: string }>();
  partial = false;
  unreadable = false;
  snapshotId = '';
  private outsideTimelineCitations = new Set<string>();
  private substitutions = new Map<string, TimelineSubstitution>();
  private constructor(
    readonly workbench: TimelineWorkbench,
    input: TimelineAnalysisRequest,
  ) {
    this.links = structuredClone(workbench.links);
    this.request = structuredClone(input);
    this.roles = rolesOf(this.links);
  }
  static async create(w: TimelineWorkbench, input: TimelineAnalysisRequest = {}) {
    if (new TextEncoder().encode(canonicalJson(input)).byteLength > TL1_LIMITS.projectionBytes)
      throw Error('診断入力が上限を超えます。範囲を分けてください。');
    if (
      input.disclosureEvidence?.some(
        (e) => !['confirmed', 'partial', 'misleading'].includes(e.mode),
      )
    )
      throw Error('未知の開示の確度です。');
    if (input.shared) throw Error('shared診断は未対応です。');
    if (input.readingPremise !== undefined)
      throw Error('作品をまたぐ読書前提の診断は未対応です。単作へ置き換えません。');
    if (input.dependencyRules && input.dependencyRules !== TIMELINE_DEPENDENCY_RULES)
      throw Error('未知の依存規則です。');
    if (input.diagnosticRules && input.diagnosticRules !== TIMELINE_DIAGNOSTIC_RULES)
      throw Error('未知の診断規則です。');
    const c = new TimelineAnalysisContext(w, input);
    const links = canonicalJson(c.links),
      epoch = w.accessEpoch;
    c.guards.push(() => canonicalJson(w.links) === links && w.accessEpoch === epoch);
    for (const [owner, role] of c.roles) {
      if (!w.readable(owner)) {
        c.partial = true;
        c.unreadable = true;
        continue;
      }
      const access = w.captureAccess(owner),
        a = await w.source.get(owner);
      c.guards.push(access);
      if (!access()) throw Error('診断の権限が変わりました。');
      const version = a?.versions.find((v) => v.versionId === a.draft.baseVersionId);
      if (!version) {
        c.partial = true;
        continue;
      }
      const adopted = { version: version.versionId, hash: version.contentHash };
      c.adopted.set(owner, adopted);
      const o = w.owner(owner),
        base = o?.editor.artifact.draft.baseVersionId;
      if (o) c.guards.push(() => o.editor.artifact.draft.baseVersionId === base);
      // Clock/rule drafts are read-set inputs even if this request uses their adopted table.
      if (role === 'world' && o) {
        const rev = o.editor.revision;
        c.guards.push(() => sameLocalRevision(o.editor.revision, rev));
      }
      const t = await c.exact({
        type: 'exact',
        artifact: owner,
        version: version.versionId,
        hash: version.contentHash,
        item: '',
      });
      if (t) c.roots.set(owner, t);
    }
    for (const candidate of c.request.candidates ?? []) {
      if (
        !candidate.id ||
        c.candidates.has(candidate.id) ||
        !c.roles.has(candidate.owner) ||
        !w.readable(candidate.owner)
      )
        throw Error('候補を確認できません。');
      const base = await c.exact({
        type: 'exact',
        artifact: candidate.owner,
        version: candidate.base,
        hash: candidate.baseHash,
        item: '',
      });
      if (!base || (await contentHash(candidate.content)) !== candidate.payloadHash)
        throw Error('候補の内容または基準版が一致しません。');
      if (candidate.localRevision) {
        const o = w.owner(candidate.owner);
        if (
          !o ||
          !sameLocalRevision(o.editor.revision, candidate.localRevision) ||
          canonicalJson(o.editor.content) !== canonicalJson(candidate.content)
        )
          throw Error('候補の下書きが変わりました。');
        c.guards.push(() => sameLocalRevision(o.editor.revision, candidate.localRevision!));
      } else if (
        canonicalJson(candidate.content) !==
        canonicalJson(
          (await w.source.get(candidate.owner))?.versions.find(
            (v) => v.versionId === candidate.base,
          )?.content,
        )
      )
        throw Error('仮想候補の内容変更は確認した参照差替表で指定してください。');
      const read = readTimelineTable(base.role, candidate.content);
      if (read.state !== 'valid') throw Error('候補の表が不正です。');
      const t: AnalysisTable = {
        key: 'candidate:' + candidate.id,
        owner: candidate.owner,
        role: base.role,
        version: candidate.base,
        hash: candidate.baseHash,
        rows: read.rows,
        candidate: candidate.id,
      };
      c.candidates.set(candidate.id, t);
      c.tables.set(t.key, t);
    }
    for (const sub of c.request.substitutions ?? []) {
      const source = c.candidates.get(sub.source),
        target = c.candidates.get(sub.to.candidate);
      const row = source?.rows.find((r) => r.id === sub.selector.row),
        old = row?.[sub.selector.ref];
      const key = canonicalJson([sub.source, sub.selector.row, sub.selector.ref]);
      if (
        !source ||
        !target ||
        !['ref', 'ref2'].includes(sub.selector.ref) ||
        source.owner !== sub.owner ||
        source.version !== sub.base ||
        !old ||
        old.type !== 'exact' ||
        canonicalJson(old) !== canonicalJson(sub.expectOld) ||
        old.artifact !== target.owner ||
        !target.rows.some((r) => r.id === sub.to.item) ||
        sub.to.item !== old.item ||
        c.substitutions.has(key)
      )
        throw Error('差替表の候補・旧参照・対象が一致しないか、同じ箇所を二重に指定しています。');
      c.substitutions.set(key, sub);
    }
    for (const [owner, id] of Object.entries(c.request.roots ?? {})) {
      const t = c.candidates.get(id);
      if (!t || t.owner !== owner) throw Error('診断の候補選択が一致しません。');
      c.roots.set(owner, t);
    }
    const all = [...c.roots.values()].flatMap((t) => t.rows);
    for (const [kind, limit] of [
      ['event', TL1_LIMITS.events],
      ['scene', TL1_LIMITS.scenes],
      ['occurrence', TL1_LIMITS.occurrences],
      ['worldline', TL1_LIMITS.worlds],
    ] as const)
      if (all.filter((r) => r.kind === kind).length > limit)
        throw Error('診断範囲の項目数が上限を超えます。');
    if (
      all.filter(
        (r) =>
          !['event', 'scene', 'occurrence', 'worldline', 'clock', 'clock-offset'].includes(r.kind),
      ).length > TL1_LIMITS.relations
    )
      throw Error('診断範囲の関係数が上限を超えます。');
    c.snapshotId = await contentHash({
      story: c.links.story,
      adopted: [...c.adopted],
      candidates: c.request.candidates ?? [],
      substitutions: c.request.substitutions ?? [],
      roots: c.request.roots ?? {},
      scope: c.request.scope ?? { kind: 'all', targets: [] },
      disclosureEvidence: c.request.disclosureEvidence ?? null,
      linksHash: await contentHash(c.links),
      dependencyRules: TIMELINE_DEPENDENCY_RULES,
      diagnosticRules: TIMELINE_DIAGNOSTIC_RULES,
      clockRevision: w.owner(c.links.story.worldSettings)?.editor.revision ?? null,
      permissionEpoch: epoch,
    });
    c.assertCurrent();
    return c;
  }
  assertBudget(value: unknown) {
    if (new TextEncoder().encode(canonicalJson(value)).byteLength > TL1_LIMITS.projectionBytes)
      throw Error('診断結果が容量上限を超えます。範囲を分けてください。');
  }
  assertCurrent() {
    if (this.guards.some((g) => !g()))
      throw Error('診断の入力・権限が変わりました。再確認してください。');
  }
  current() {
    try {
      this.assertCurrent();
      return true;
    } catch {
      return false;
    }
  }
  fixed(owner: string) {
    const base = this.adopted.get(owner);
    return base ? this.tables.get(canonicalJson([owner, base.version, base.hash])) : undefined;
  }
  async exact(ref: Exact): Promise<AnalysisTable | undefined> {
    if (!this.workbench.readable(ref.artifact)) {
      this.unreadable = true;
      this.partial = true;
      return;
    }
    const key = canonicalJson([ref.artifact, ref.version, ref.hash]);
    const cached = this.tables.get(key);
    if (cached) return cached;
    const access = this.workbench.captureAccess(ref.artifact),
      a = await this.workbench.source.get(ref.artifact);
    this.guards.push(access);
    if (!access()) throw Error('診断の権限が変わりました。');
    const versions = a?.versions.filter((v) => v.versionId === ref.version),
      v = versions?.length === 1 ? versions[0] : undefined;
    const role = this.roles.get(ref.artifact);
    if (
      !v ||
      a?.id !== ref.artifact ||
      !role ||
      v.contentHash !== ref.hash ||
      (await contentHash(v.content)) !== ref.hash
    ) {
      this.partial = true;
      return;
    }
    const read = readTimelineTable(role, v.content);
    if (read.state !== 'valid') {
      this.partial = true;
      return;
    }
    const t: AnalysisTable = {
      key,
      owner: ref.artifact,
      role,
      version: ref.version,
      hash: ref.hash,
      rows: read.rows,
    };
    this.tables.set(key, t);
    return t;
  }
  async resolve(
    source: AnalysisTable,
    row: TimelineRow,
    which: 'ref' | 'ref2' = 'ref',
  ): Promise<AnalysisNode | undefined> {
    const ref = row[which];
    if (!ref) return;
    if (ref.type === 'exact' && !this.workbench.readable(ref.artifact)) {
      this.unreadable = true;
      this.partial = true;
      return;
    }
    // A native CH/LO citation is validated by the existing reference reader, but has
    // no event semantics. A valid out-of-scope target is different from a missing one.
    if (row.kind === 'cite' && ref.type === 'exact' && !this.roles.has(ref.artifact)) {
      const key = canonicalJson(ref);
      if (this.outsideTimelineCitations.has(key)) return;
      const access = this.workbench.captureAccess(ref.artifact);
      this.guards.push(access);
      try {
        const artifact = await this.workbench.source.get(ref.artifact);
        const content = artifact?.versions.find((v) => v.versionId === ref.version)?.content;
        if (
          !(
            isDocument(content) ||
            (isStructuredData(content) && !content.columns.some((c) => c.id.startsWith('tl1.')))
          )
        ) {
          this.partial = true;
          return;
        }
        await verifyNewReferences(
          this.workbench.source,
          [{ id: row.id, values: { ...row.cells } }],
          (id) => this.workbench.readable(id),
        );
        this.outsideTimelineCitations.add(key);
      } catch {
        this.partial = true;
        if (!this.workbench.readable(ref.artifact)) this.unreadable = true;
      }
      if (!access()) throw Error('診断の権限が変わりました。');
      return;
    }
    const sub = source.candidate
      ? this.substitutions.get(canonicalJson([source.candidate, row.id, which]))
      : undefined;
    const t = sub
      ? this.candidates.get(sub.to.candidate)
      : ref.type === 'internal'
        ? source
        : await this.exact(ref);
    const target = t?.rows.find((r) => r.id === (sub?.to.item ?? ref.item));
    if (!t || !target) {
      this.partial = true;
      return;
    }
    return { table: t, row: target };
  }
}
