/** Host-owned progress of native composition save + occurrence-link CAS; never edit history. */
import {
  canonicalJson,
  contentHash,
  newId,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import { sameLocalRevision } from '@editor-platform/editor-core';
import { readWorkspaceLinks, type CreativeWorkspaceLinksV2 } from '../workspace/model';
import type { TimelineWorkbench } from './workbench';
export interface TimelineSaveReceipt {
  schemaVersion: 1 | 2;
  operationId: string;
  owner: string;
  candidateHash: string;
  /** Durable version identities observed before this save attempt. Missing on legacy receipts. */
  beforeVersionIds?: string[];
  savedVersionId: string | null;
  contentHash: string | null;
  linksExpectedHash: string;
  expected: CreativeWorkspaceLinksV2;
  linkIds: string[];
  state: 'unsaved' | 'source-saved-links-pending' | 'complete';
}
export interface TimelineRecoveryStore {
  readonly artifacts: Pick<StorageAdapter<Artifact<unknown>>, 'get'>;
  readLinks(): CreativeWorkspaceLinksV2 | Promise<CreativeWorkspaceLinksV2>;
  /** Atomic CAS, including against other tabs/writers using this store. */
  writeLinks(
    next: CreativeWorkspaceLinksV2,
    expected: CreativeWorkspaceLinksV2,
    validate: () => void,
  ): Promise<void>;
  receipts(): Promise<TimelineSaveReceipt[]>;
  writeReceipt(next: TimelineSaveReceipt, expected: TimelineSaveReceipt | null): Promise<void>;
  /** Serializes this explicit save/retry across Host instances; no automatic background retry. */
  exclusive<T>(owner: string, work: () => Promise<T>): Promise<T>;
}
export interface TimelineSavePlan {
  readonly receipt: TimelineSaveReceipt;
}
export function readTimelineSaveReceipt(raw: unknown): TimelineSaveReceipt {
  const r = raw as TimelineSaveReceipt;
  const hash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  if (
    !r ||
    ![1, 2].includes(r.schemaVersion) ||
    (r.schemaVersion === 2 && !Array.isArray(r.beforeVersionIds)) ||
    typeof r.operationId !== 'string' ||
    !r.operationId ||
    typeof r.owner !== 'string' ||
    !r.owner ||
    !hash(r.candidateHash) ||
    (r.beforeVersionIds !== undefined &&
      (!Array.isArray(r.beforeVersionIds) ||
        r.beforeVersionIds.some((id) => typeof id !== 'string' || !id) ||
        new Set(r.beforeVersionIds).size !== r.beforeVersionIds.length)) ||
    !hash(r.linksExpectedHash) ||
    !['unsaved', 'source-saved-links-pending', 'complete'].includes(r.state) ||
    !Array.isArray(r.linkIds) ||
    !r.linkIds.length ||
    r.linkIds.length > 2000 ||
    new Set(r.linkIds).size !== r.linkIds.length ||
    r.linkIds.some((id) => typeof id !== 'string')
  )
    throw Error('保存復旧記録の形式が不正です。');
  const expected = readWorkspaceLinks(r.expected);
  if (
    expected.schemaVersion !== 2 ||
    expected.story.composition !== r.owner ||
    r.linkIds.some(
      (id) =>
        !expected.occurrenceLinks.some((l) => l.id === id && l.occurrence.artifactId === r.owner),
    ) ||
    (r.state === 'unsaved'
      ? r.savedVersionId !== null || r.contentHash !== null
      : typeof r.savedVersionId !== 'string' || !r.savedVersionId || !hash(r.contentHash))
  )
    throw Error('保存復旧記録の参照が不正です。');
  return structuredClone(r);
}
export class TimelineSaveRecovery {
  private plans = new WeakMap<TimelineSavePlan, { receipt: TimelineSaveReceipt; assert(): void }>();
  constructor(
    readonly workbench: TimelineWorkbench,
    readonly store: TimelineRecoveryStore,
    private readonly published: (links: CreativeWorkspaceLinksV2) => void,
  ) {}
  private access(owner: string) {
    const o = this.workbench.owner(owner);
    if (!o || o.editor.readOnly || o.role !== 'composition')
      throw Error('この資料を保存・再接続できません。');
    return o;
  }
  private async stored(owner: string): Promise<Artifact<StructuredData>> {
    this.access(owner);
    const current = this.workbench.captureAccess(owner),
      a = await this.store.artifacts.get(owner);
    if (
      !current() ||
      !a ||
      a.id !== owner ||
      a.kind !== 'data' ||
      !a.versions.every((v) => isStructuredData(v.content))
    )
      throw Error('保持版を確認できません。');
    return a as Artifact<StructuredData>;
  }
  async list() {
    return (await this.store.receipts())
      .map(readTimelineSaveReceipt)
      .filter(
        (r) =>
          this.workbench.readable(r.owner) && r.owner === this.workbench.links.story.composition,
      );
  }
  async prepare(owner: string): Promise<TimelineSavePlan> {
    const w = this.workbench,
      o = this.access(owner);
    const input = o.inputs.getSnapshot();
    if (input.dirty || input.composing || input.settling)
      throw Error('入力を確定または取消してください。');
    const revision = o.editor.revision,
      current = w.captureAccess(owner),
      initial = o.editor.content;
    const expected = structuredClone(await this.store.readLinks());
    const assert = () => {
      this.access(owner);
      if (
        !current() ||
        !sameLocalRevision(revision, o.editor.revision) ||
        canonicalJson(w.links.story) !== canonicalJson(expected.story)
      )
        throw Error('保存する資料が変わりました。再準備してください。');
      const input = o.inputs.getSnapshot();
      if (input.dirty || input.composing || input.settling) throw Error('未確定の入力があります。');
    };
    assert();
    const links = expected.occurrenceLinks.filter((l) => l.occurrence.artifactId === owner);
    if (!links.length) throw Error('更新する原稿対応がありません。');
    if (
      links.some(
        (l) =>
          !initial.rows.some(
            (r) => r.id === l.occurrence.itemId && r.values['tl1.row'] === 'occurrence',
          ),
      )
    )
      throw Error('対応先の提示位置がありません。対応を明示的に直してください。');
    const receipt: TimelineSaveReceipt = {
      schemaVersion: 2,
      operationId: newId('timeline-save'),
      owner,
      candidateHash: await contentHash(initial),
      beforeVersionIds: (await this.stored(owner)).versions.map((v) => v.versionId),
      savedVersionId: null,
      contentHash: null,
      linksExpectedHash: await contentHash(expected),
      expected,
      linkIds: links.map((l) => l.id),
      state: 'unsaved',
    };
    assert();
    const plan = { receipt: structuredClone(receipt) };
    this.plans.set(plan, { receipt, assert });
    return plan;
  }
  /** Preview confirmation. Native save once, then only the selected correspondence pins. */
  async commit(plan: TimelineSavePlan) {
    const prepared = this.plans.get(plan);
    if (!prepared) throw Error('この保存確認は消費済みです。');
    this.plans.delete(plan);
    const { receipt, assert } = prepared;
    return this.store.exclusive(receipt.owner, async () => {
      assert();
      if (canonicalJson(await this.store.readLinks()) !== canonicalJson(receipt.expected))
        throw Error('原稿対応表が変わりました。再準備してください。');
      assert();
      if (
        receipt.state === 'unsaved' &&
        canonicalJson(
          (await this.stored(receipt.owner)).versions.map((v) => v.versionId).sort(),
        ) !== canonicalJson([...receipt.beforeVersionIds!].sort())
      )
        throw Error('保持版が変わりました。保存を再準備してください。');
      assert();
      await this.store.writeReceipt(receipt, null);
      return receipt.state === 'source-saved-links-pending'
        ? this.publish(receipt)
        : this.saveSource(receipt, assert);
    });
  }
  /** Receipt loss: preview the unique descendant of the old linked version, never the latest. */
  async prepareReconnect(owner: string): Promise<TimelineSavePlan> {
    const original = await this.prepare(owner),
      prepared = this.plans.get(original)!;
    this.plans.delete(original);
    const { receipt, assert } = prepared;
    const versions = (await this.stored(owner)).versions;
    const old = new Set(
      receipt.expected.occurrenceLinks
        .filter((l) => receipt.linkIds.includes(l.id))
        .map((l) => l.occurrence.versionId),
    );
    const descendant = (id: string | null): boolean => {
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        if (old.has(id)) return true;
        seen.add(id);
        id = versions.find((v) => v.versionId === id)?.parentVersionId ?? null;
      }
      return false;
    };
    const candidates = versions.filter(
      (v) => !old.has(v.versionId) && descendant(v.parentVersionId),
    );
    if (candidates.length !== 1)
      throw Error(
        candidates.length
          ? '再接続できる保持版が複数あります。最新版を推定できません。'
          : '再接続できる保持版がありません。',
      );
    const saved = candidates[0];
    if ((await contentHash(saved.content)) !== saved.contentHash)
      throw Error('保持版のhashが一致しません。');
    assert();
    const next: TimelineSaveReceipt = {
      ...receipt,
      candidateHash: saved.contentHash,
      savedVersionId: saved.versionId,
      contentHash: saved.contentHash,
      state: 'source-saved-links-pending',
    };
    const plan = { receipt: structuredClone(next) };
    this.plans.set(plan, { receipt: next, assert });
    return plan;
  }
  private async saveSource(receipt: TimelineSaveReceipt, assert: () => void) {
    assert();
    const o = this.access(receipt.owner),
      current = this.workbench.captureAccess(receipt.owner);
    const revision = o.editor.revision;
    if ((await contentHash(o.editor.content)) !== receipt.candidateHash)
      throw Error('未保存の内容が変わりました。再準備してください。');
    assert();
    // This is the existing native save, never command reapplication.
    const result = await this.workbench.save(receipt.owner);
    if (!current()) throw Error('保存結果の表示は無効になりました。');
    if (!result.ok || !result.versionId)
      throw Error('資料を保存できませんでした。未保存の編集を保持しています。');
    const saved = o.editor.artifact.versions.find((v) => v.versionId === result.versionId);
    if (!saved || saved.contentHash !== receipt.candidateHash)
      throw Error('保存内容が確認した候補と一致しません。復旧で照合してください。');
    const next: TimelineSaveReceipt = {
      ...receipt,
      savedVersionId: saved.versionId,
      contentHash: saved.contentHash,
      state: 'source-saved-links-pending',
    };
    await this.store.writeReceipt(next, receipt);
    if (!current() || !sameLocalRevision(revision, o.editor.revision))
      throw Error('本体は保存済みですが、その後の編集があります。対応表は更新せず復旧を待ちます。');
    return this.publish(next);
  }
  private async publish(receipt: TimelineSaveReceipt) {
    const o = this.access(receipt.owner),
      current = this.workbench.captureAccess(receipt.owner);
    const revision = o.editor.revision;
    const saved = (await this.stored(receipt.owner)).versions.filter(
      (v) => v.versionId === receipt.savedVersionId,
    );
    if (
      saved.length !== 1 ||
      saved[0].contentHash !== receipt.contentHash ||
      (await contentHash(saved[0].content)) !== receipt.contentHash ||
      (await contentHash(receipt.expected)) !== receipt.linksExpectedHash
    )
      throw Error('保持された保存版または対応表の根拠が一致しません。');
    if (
      receipt.linkIds.some((id) => {
        const item = receipt.expected.occurrenceLinks.find((l) => l.id === id)!.occurrence.itemId;
        return !saved[0].content.rows.some(
          (r) => r.id === item && r.values['tl1.row'] === 'occurrence',
        );
      })
    )
      throw Error('保存版の提示位置がありません。');
    const next = structuredClone(receipt.expected);
    for (const link of next.occurrenceLinks)
      if (receipt.linkIds.includes(link.id)) {
        link.occurrence.versionId = receipt.savedVersionId!;
        link.occurrence.contentHash = receipt.contentHash!;
      }
    readWorkspaceLinks(next);
    const stored = await this.store.readLinks();
    const validate = () => {
      if (!current() || !sameLocalRevision(revision, o.editor.revision))
        throw Error('資料または参照権限が変わりました。再確認してください。');
      this.access(receipt.owner);
      const currentLinks = canonicalJson(this.workbench.links);
      if (currentLinks !== canonicalJson(receipt.expected) && currentLinks !== canonicalJson(next))
        throw Error('表示中の対応表が変わりました。');
    };
    validate();
    // Recovery after a crash between successful CAS and the completion receipt.
    if (canonicalJson(stored) !== canonicalJson(next))
      await this.store.writeLinks(next, receipt.expected, validate);
    if (!current()) throw Error('保存結果の表示は無効になりました。');
    const complete: TimelineSaveReceipt = { ...receipt, state: 'complete' };
    await this.store.writeReceipt(complete, receipt);
    if (current()) this.published(structuredClone(next));
    return complete;
  }
  private operationCandidates(receipt: TimelineSaveReceipt, artifact: Artifact<StructuredData>) {
    if (!receipt.beforeVersionIds)
      throw Error(
        '旧形式の復旧記録では今回の保存版を特定できません。明示再接続で確認してください。',
      );
    const before = new Set(receipt.beforeVersionIds);
    return artifact.versions.filter(
      (v) => !before.has(v.versionId) && v.contentHash === receipt.candidateHash,
    );
  }
  /** Explicit retry. A pending-link receipt can never call native save again. */
  async retry(operationId: string) {
    const initial = (await this.list()).find((r) => r.operationId === operationId);
    if (!initial) throw Error('復旧記録を読めません。');
    return this.store.exclusive(initial.owner, async () => {
      const receipt = (await this.list()).find((r) => r.operationId === operationId)!;
      if (receipt.state === 'complete') return receipt;
      if (receipt.state === 'source-saved-links-pending') return this.publish(receipt);
      const o = this.access(receipt.owner),
        revision = o.editor.revision;
      if (this.operationCandidates(receipt, await this.stored(receipt.owner)).length)
        throw Error('保存済みの可能性があります。保持版を照合して復旧してください。');
      const current = this.workbench.captureAccess(receipt.owner);
      return this.saveSource(receipt, () => {
        this.access(receipt.owner);
        if (
          !current() ||
          !sameLocalRevision(revision, o.editor.revision) ||
          o.inputs.getSnapshot().dirty
        )
          throw Error('未保存の資料が変わりました。');
      });
    });
  }
  /** Explicit unique retained-version match; never latest/name guessing or automatic adoption. */
  async recover(operationId: string) {
    const initial = (await this.list()).find((r) => r.operationId === operationId);
    if (!initial) throw Error('復旧記録を読めません。');
    return this.store.exclusive(initial.owner, async () => {
      const receipt = (await this.list()).find((r) => r.operationId === operationId)!;
      if (receipt.state !== 'unsaved')
        return receipt.state === 'complete' ? receipt : this.publish(receipt);
      const candidates = this.operationCandidates(receipt, await this.stored(receipt.owner));
      if (candidates.length !== 1)
        throw Error(
          candidates.length
            ? '一致する保持版が複数あります。自動再接続できません。'
            : '一致する保持版がありません。未保存の編集を確認してください。',
        );
      const saved = candidates[0];
      const next: TimelineSaveReceipt = {
        ...receipt,
        savedVersionId: saved.versionId,
        contentHash: saved.contentHash,
        state: 'source-saved-links-pending',
      };
      await this.store.writeReceipt(next, receipt);
      return this.publish(next);
    });
  }
}
