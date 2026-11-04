/** Explicit EV-save→SC-cite and SC-save→occurrence workflows over existing native editors. */
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import { sameLocalRevision, type EditorCommand } from '@editor-platform/editor-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { insertRows, type TimelineRowInput } from './commands';
import type { TimelineWorkbench } from './workbench';
export interface TimelineTwoStepReceipt {
  sourceOperationId: string;
  sourceOwner: string;
  item: string;
  kind: 'event' | 'scene';
  saved?: { versionId: string; contentHash: string };
  connectionOperationId?: string;
  targetOwner?: string;
  targetRow?: TimelineRowInput;
  targetVersionId?: string;
  state: 'source-unsaved' | 'source-saved-unlinked' | 'connection-unsaved' | 'complete';
}
export type TimelineConnection =
  | { owner: string; scene: string }
  | { owner: string; order: number; part: string; label: string };
export interface TimelineConnectionPreview {
  readonly operationId: string;
  readonly row: TimelineRowInput;
  readonly targetOwner: string;
}
export class TimelineTwoStep {
  private records = new Map<string, TimelineTwoStepReceipt>();
  private busy = new Set<string>();
  private previews = new WeakMap<
    TimelineConnectionPreview,
    {
      command: EditorCommand<StructuredData>;
      receipt: TimelineTwoStepReceipt;
      operationId: string;
      targetOwner: string;
      row: TimelineRowInput;
    }
  >();
  constructor(readonly workbench: TimelineWorkbench) {}
  list() {
    return [...this.records.values()]
      .filter(
        (r) =>
          this.workbench.readable(r.sourceOwner) &&
          (!r.targetOwner || this.workbench.readable(r.targetOwner)),
      )
      .map((r) => structuredClone(r));
  }
  private get(id: string) {
    const r = this.records.get(id);
    if (
      !r ||
      !this.workbench.readable(r.sourceOwner) ||
      (r.targetOwner && !this.workbench.readable(r.targetOwner))
    )
      throw Error('この操作記録を読めません。');
    return r;
  }
  begin(sourceOwner: string, item: string): TimelineTwoStepReceipt {
    const o = this.workbench.owner(sourceOwner),
      row = o?.editor.content.rows.find((r) => r.id === item);
    const kind = row?.values['tl1.row'];
    if (
      !o ||
      o.editor.readOnly ||
      !((o.role === 'ledger' && kind === 'event') || (o.role === 'scene-cards' && kind === 'scene'))
    )
      throw Error('保存する出来事または場面を選んでください。');
    const r: TimelineTwoStepReceipt = {
      sourceOperationId: newId('timeline-source'),
      sourceOwner,
      item,
      kind: kind as 'event' | 'scene',
      state: 'source-unsaved',
    };
    this.records.set(r.sourceOperationId, r);
    return structuredClone(r);
  }
  private async exclusive<T>(id: string, work: () => Promise<T>) {
    if (this.busy.has(id)) throw Error('この段階の保存・確認は処理中です。');
    this.busy.add(id);
    try {
      return await work();
    } finally {
      this.busy.delete(id);
    }
  }
  async saveSource(id: string) {
    return this.exclusive(id, async () => {
      const r = this.get(id),
        w = this.workbench;
      if (r.state !== 'source-unsaved') return structuredClone(r);
      const current = w.captureAccess(r.sourceOwner);
      const saved = await w.save(r.sourceOwner);
      if (!current()) throw Error('保存結果の表示は無効になりました。');
      if (!saved.ok || !saved.versionId)
        throw Error('第一段階は未保存です。第二段階へ進めません。');
      const version = w
        .owner(r.sourceOwner)!
        .editor.artifact.versions.find((v) => v.versionId === saved.versionId);
      if (
        !version?.content.rows.some((row) => row.id === r.item && row.values['tl1.row'] === r.kind)
      )
        throw Error('保存版に対象項目がありません。');
      r.saved = { versionId: version.versionId, contentHash: version.contentHash };
      r.state = 'source-saved-unlinked';
      return structuredClone(r);
    });
  }
  async prepareConnection(
    id: string,
    target: TimelineConnection,
    signal: AbortSignal,
  ): Promise<TimelineConnectionPreview> {
    const r = this.get(id),
      w = this.workbench,
      o = w.owner(target.owner);
    if (r.state !== 'source-saved-unlinked' || !r.saved)
      throw Error('第一段階を保存してから接続してください。');
    if (
      !o ||
      o.editor.readOnly ||
      (r.kind === 'event'
        ? o.role !== 'scene-cards' || !('scene' in target)
        : o.role !== 'composition' || !('order' in target))
    )
      throw Error('第二段階の保存先が違います。');
    const before = o.inputs.getSnapshot();
    if (before.dirty || before.composing || before.settling || signal.aborted)
      throw Error('未確定の入力を確定または取消してください。');
    const ticket = w.watch(target.owner, 'two-step:' + id, () => [
      o.editor.revision,
      w.links.story,
    ]);
    const remove = o.forms.register({
      dirty: () => true,
      focus() {},
      consume() {},
      finalize() {},
      prepare() {
        throw Error('参照先を確認中です。');
      },
    });
    const cancel = () => {
      ticket.cancel();
      remove();
    };
    signal.addEventListener('abort', cancel, { once: true });
    const operationId = newId('timeline-connection');
    const row: TimelineRowInput = {
      id:
        r.kind === 'event'
          ? w.nextRelationId(o.id, ('scene' in target ? target.scene : '') + '.cite.' + r.item)
          : w.nextId(o.id, 'OC'),
      values: {
        'tl1.ref.artifact': r.sourceOwner,
        'tl1.ref.version': r.saved.versionId,
        'tl1.ref.hash': r.saved.contentHash,
        'tl1.ref.item': r.item,
        ...(r.kind === 'event' && 'scene' in target
          ? { 'tl1.row': 'cite', 'tl1.subject': target.scene, 'tl1.ref.facet': 'whole' }
          : 'order' in target
            ? {
                'tl1.row': 'occurrence',
                'tl1.order': target.order,
                'tl1.part': target.part,
                'tl1.label': target.label,
              }
            : {}),
      },
    };
    try {
      if (
        r.kind === 'event' &&
        o.editor.content.rows.some(
          (x) =>
            x.values['tl1.row'] === 'cite' &&
            x.values['tl1.subject'] === row.values['tl1.subject'] &&
            ['artifact', 'version', 'hash', 'item'].every(
              (k) => x.values['tl1.ref.' + k] === row.values['tl1.ref.' + k],
            ),
        )
      )
        throw Error('この保存版は既に引用されています。');
      const verified = await w.verify([row]);
      const command = insertRows(
        o.role,
        verified,
        r.kind === 'event' ? '保存した出来事を引用' : '保存した場面を配置',
      );
      const assert = () => {
        if (signal.aborted || r.state !== 'source-saved-unlinked')
          throw Error('この接続確認は取消または消費済みです。');
        ticket.assert();
      };
      assert();
      command.apply(o.editor.content); // full native preflight, no mutation
      const preview = { operationId, row: structuredClone(row), targetOwner: o.id };
      this.previews.set(preview, {
        receipt: r,
        operationId,
        targetOwner: o.id,
        row: structuredClone(row),
        command: {
          ...command,
          context: { origin: 'local', ...command.context, transactionId: operationId },
          apply: (content) => {
            assert();
            return command.apply(content);
          },
        },
      });
      return preview;
    } catch (e) {
      cancel();
      throw e;
    } finally {
      remove();
    }
  }
  commitConnection(preview: TimelineConnectionPreview) {
    const p = this.previews.get(preview);
    if (!p) throw Error('接続確認がありません。');
    this.previews.delete(preview);
    const r = this.get(p.receipt.sourceOperationId);
    const inputs = this.workbench.owner(p.targetOwner)?.inputs.getSnapshot();
    if (!inputs || inputs.dirty || inputs.composing || inputs.settling)
      throw Error('接続先の未確定入力を確定または取消して、もう一度確認してください。');
    const result = this.workbench.run(p.targetOwner, () => p.command);
    if (!result.ok) throw Error(result.message);
    r.connectionOperationId = p.operationId;
    r.targetOwner = p.targetOwner;
    r.targetRow = structuredClone(p.row);
    r.state = 'connection-unsaved';
    return structuredClone(r);
  }
  async saveConnection(id: string) {
    return this.exclusive(id, async () => {
      const r = this.get(id),
        w = this.workbench;
      if (r.state === 'complete') return structuredClone(r);
      if (r.state !== 'connection-unsaved' || !r.targetOwner || !r.targetRow)
        throw Error('未保存の接続がありません。');
      const current = w.captureAccess(r.targetOwner),
        o = w.owner(r.targetOwner);
      const row = o?.editor.content.rows.find((x) => x.id === r.targetRow!.id);
      if (!row || canonicalJson(row) !== canonicalJson(r.targetRow))
        throw Error('接続が変更・取消されました。別の内容を保存済みにできません。');
      const revision = o!.editor.revision;
      const result = await w.save(r.targetOwner);
      if (!current()) throw Error('保存結果の表示は無効になりました。');
      if (!result.ok || !result.versionId)
        throw Error('関連付けは未保存です。保存だけを再試行してください。');
      if (!sameLocalRevision(revision, o!.editor.revision))
        throw Error('保存後に接続先が編集されました。現在の下書きを確認してください。');
      r.targetVersionId = result.versionId;
      r.state = 'complete';
      return structuredClone(r);
    });
  }
}

// The operation receipt belongs to the editing session, not a mounted panel.
const sessionFlows = new WeakMap<TimelineWorkbench, TimelineTwoStep>();
export function timelineTwoStep(workbench: TimelineWorkbench) {
  let flow = sessionFlows.get(workbench);
  if (!flow) {
    flow = new TimelineTwoStep(workbench);
    sessionFlows.set(workbench, flow);
  }
  return flow;
}
