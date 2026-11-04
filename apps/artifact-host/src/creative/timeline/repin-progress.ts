/** Session progress for explicit owner-local re-pins. Never rolls back other owners. */
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import { sameLocalRevision, type LocalDraftRevision } from '@editor-platform/editor-core';
import { exactRefCells, type TimelineRepinManifest } from './repin';
import type { TimelineWorkbench } from './workbench';
export interface TimelineRepinReceipt {
  id: string;
  manifest: TimelineRepinManifest;
  revision: LocalDraftRevision;
  state: 'applied-unsaved' | 'save-failed' | 'saved';
  versionId?: string;
}
export class TimelineRepinProgress {
  private records = new Map<string, TimelineRepinReceipt>();
  private busy = new Set<string>();
  private contents = new Map<string, string>();
  private versionsBefore = new Map<string, Set<string>>();
  constructor(readonly workbench: TimelineWorkbench) {}
  private readable(r: TimelineRepinReceipt) {
    return (
      this.workbench.readable(r.manifest.owner) &&
      r.manifest.rows.every(
        (x) => this.workbench.readable(x.old.artifact) && this.workbench.readable(x.new.artifact),
      )
    );
  }
  list() {
    for (const r of this.records.values()) {
      if (!this.readable(r) || r.state === 'saved') continue;
      const saved = this.workbench
        .owner(r.manifest.owner)
        ?.editor.artifact.versions.find(
          (v) =>
            !this.versionsBefore.get(r.id)!.has(v.versionId) &&
            canonicalJson(v.content) === this.contents.get(r.id),
        );
      if (saved) {
        r.state = 'saved';
        r.versionId = saved.versionId;
      }
    }
    return [...this.records.values()]
      .filter((r) => this.readable(r))
      .map((r) => structuredClone(r));
  }
  recordApplied(manifest: TimelineRepinManifest) {
    const w = this.workbench,
      o = w.owner(manifest.owner);
    if (
      !o ||
      !manifest.rows.length ||
      manifest.rows.some(
        (c) =>
          canonicalJson(
            exactRefCells(w.rows(o.id).find((r) => r.id === c.row)?.values ?? {}, c.ref) ?? null,
          ) !== canonicalJson(c.new),
      )
    )
      throw Error('再固定した結果と一致しません。');
    const receipt: TimelineRepinReceipt = {
      id: newId('timeline-repin'),
      manifest: structuredClone(manifest),
      revision: o.editor.revision,
      state: 'applied-unsaved',
    };
    this.records.set(receipt.id, receipt);
    this.versionsBefore.set(
      receipt.id,
      new Set(o.editor.artifact.versions.map((v) => v.versionId)),
    );
    this.contents.set(receipt.id, canonicalJson(o.editor.content));
    return structuredClone(receipt);
  }
  async save(id: string) {
    const r = this.records.get(id),
      w = this.workbench;
    if (!r || !this.readable(r)) throw Error('再固定結果を読めません。');
    if (r.state === 'saved') return structuredClone(r);
    if (this.busy.has(id)) throw Error('この資料を保存中です。');
    const o = w.owner(r.manifest.owner)!;
    const before = o.inputs.getSnapshot();
    if (
      !sameLocalRevision(o.editor.revision, r.revision) ||
      before.dirty ||
      before.composing ||
      before.settling
    )
      throw Error('確定後に資料または入力が変わりました。現在の内容を通常保存で確認してください。');
    const current = w.captureAccess(o.id);
    this.busy.add(id);
    try {
      const result = await w.save(o.id);
      if (!current()) throw Error('保存結果の表示は無効になりました。');
      if (!result.ok || !result.versionId) {
        r.state = 'save-failed';
        throw Error('この資料の保存に失敗しました。他の資料の完了は維持します。');
      }
      if (!sameLocalRevision(o.editor.revision, r.revision))
        throw Error('保存中に資料が変わりました。現在の内容を確認してください。');
      r.state = 'saved';
      r.versionId = result.versionId;
      return structuredClone(r);
    } finally {
      this.busy.delete(id);
    }
  }
}

const sessionProgress = new WeakMap<TimelineWorkbench, TimelineRepinProgress>();
export function timelineRepinProgress(w: TimelineWorkbench) {
  let progress = sessionProgress.get(w);
  if (!progress) {
    progress = new TimelineRepinProgress(w);
    sessionProgress.set(w, progress);
  }
  return progress;
}
