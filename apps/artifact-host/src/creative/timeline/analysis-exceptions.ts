/** One exception belongs to the diagnostic's captured Story/kind, never the displayed world. */
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { insertRows, type TimelineRowInput } from './commands';
import type { TimelineWorkbench } from './workbench';
import type { Exact } from './analysis-context';
import type { TimelineDiagnosticKind, TimelineDiagnostic } from './analysis-semantics';
import { readTimelineTable, type TimelineRole } from './table';
export interface TimelineExceptionInput {
  story: string;
  kind: TimelineDiagnosticKind;
  scope: string;
  rule: string;
  targets: Exact[];
  basis: Exact[];
  hypothesis?: string;
  reason: string;
}
export interface TimelineExceptionPreview {
  readonly owner: string;
  readonly id: string;
  readonly input: TimelineExceptionInput;
}
const cells = (r: Exact) =>
  Object.fromEntries(
    ['artifact', 'version', 'hash', 'item', 'facet'].flatMap((k) =>
      r[k as keyof Exact] === undefined ? [] : [['tl1.ref.' + k, r[k as keyof Exact]]],
    ),
  ) as TimelineRowInput['values'];
export function exceptionOwner(w: TimelineWorkbench, input: TimelineExceptionInput) {
  if (input.story !== w.links.story.id) throw Error('診断を開始したStoryと一致しません。');
  if (!input.targets.length || !input.basis.length || !input.reason.trim())
    throw Error('診断の対象・根拠・理由を指定してください。');
  if (input.kind === 'single-event') {
    if (
      input.targets.length !== 1 ||
      !w.links.story.ledgers.some((l) => l.artifactId === input.targets[0].artifact)
    )
      throw Error('単体診断はこのStoryのEVだけを対象にします。');
    return input.targets[0].artifact;
  }
  return input.kind === 'disclosure' ? w.links.story.composition : w.links.story.worldSettings;
}
export class TimelineExceptionRecorder {
  private prepared = new WeakMap<
    TimelineExceptionPreview,
    { owner: string; id: string; command: EditorCommand<StructuredData> }
  >();
  constructor(readonly workbench: TimelineWorkbench) {}
  async prepare(
    input: TimelineExceptionInput,
    signal: AbortSignal,
    current: () => boolean = () => true,
  ): Promise<TimelineExceptionPreview> {
    const copy = structuredClone(input),
      w = this.workbench,
      owner = exceptionOwner(w, copy),
      o = w.owner(owner);
    if (!o || !w.editable(owner))
      throw Error('診断kindで決まる例外の保存先を編集できません。別の資料へ退避しません。');
    const before = o.inputs.getSnapshot();
    if (before.composing || before.settling) throw Error('未確定入力を先に処理してください。');
    const id = w.nextRelationId(owner, 'exception'),
      ticket = w.watch(owner, 'exception', () => [o.editor.revision, w.links.story]);
    const remove = o.forms.register({
      dirty: () => true,
      focus() {},
      consume() {},
      finalize() {},
      prepare() {
        throw Error('例外の根拠を確認中です。');
      },
    });
    const cancel = () => {
      ticket.cancel();
      remove();
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const rows: TimelineRowInput[] = [
        {
          id,
          values: {
            'tl1.row': 'exception',
            'tl1.diag': copy.kind,
            'tl1.rule': copy.rule,
            'tl1.scope': copy.scope,
            'tl1.reason': copy.reason,
            ...(copy.kind === 'single-event' ? { 'tl1.subject': copy.targets[0].item } : {}),
            ...(copy.hypothesis ? { 'tl1.hypothesis': copy.hypothesis } : {}),
          },
        },
      ];
      if (copy.kind !== 'single-event')
        for (const [i, ref] of copy.targets.entries())
          rows.push({
            id: id + '.target.' + i,
            values: { 'tl1.row': 'exception-target', 'tl1.subject': id, ...cells(ref) },
          });
      for (const [i, ref] of copy.basis.entries())
        rows.push({
          id: id + '.basis.' + i,
          values: { 'tl1.row': 'exception-basis', 'tl1.subject': id, ...cells(ref) },
        });
      const verified = await w.verify(rows),
        command = insertRows(o.role, verified, 'この診断の例外を記録');
      const assert = () => {
        ticket.assert();
        if (!current()) throw Error('診断の前提が変わりました。再診断してください。');
        if (signal.aborted) throw Error('例外の記録を取り消しました。');
      };
      assert();
      command.apply(o.editor.content);
      const preview = { owner, id, input: structuredClone(copy) };
      this.prepared.set(preview, {
        owner,
        id,
        command: {
          ...command,
          apply: (d) => {
            assert();
            return command.apply(d);
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
  commit(preview: TimelineExceptionPreview) {
    const p = this.prepared.get(preview);
    if (!p) throw Error('例外の確認がありません。');
    this.prepared.delete(preview);
    const inputs = this.workbench.owner(p.owner)?.inputs.getSnapshot();
    if (!inputs || inputs.dirty || inputs.composing || inputs.settling)
      throw Error('未確定入力があるため例外を確定できません。');
    const result = this.workbench.run(p.owner, () => p.command);
    if (!result.ok) throw Error(result.message);
    return { owner: p.owner, id: p.id };
  }
  /** Existing EditForm/owner.forms commits this through its atomic native preflight. */
  nativeCommand(preview: TimelineExceptionPreview) {
    const p = this.prepared.get(preview);
    if (!p) throw Error('例外の確認がありません。');
    this.prepared.delete(preview);
    return p.command;
  }
}
/** A comparison is scoped to one diagnostic. It never erases a warning globally. */
export function exceptionMatches(
  record: TimelineExceptionInput,
  current: Omit<TimelineExceptionInput, 'reason'>,
) {
  const signature = (v: Omit<TimelineExceptionInput, 'reason'>) =>
    canonicalJson([
      v.story,
      v.kind,
      v.scope,
      v.rule,
      v.hypothesis ?? null,
      [...v.targets].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
      [...v.basis].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    ]);
  return signature(record) === signature(current) ? 'applies' : 'recheck';
}

/** Native record reader; exact audit references are never rewritten during matching. */
export function readTimelineException(
  w: TimelineWorkbench,
  owner: string,
  id: string,
): TimelineExceptionInput | undefined {
  const row = w.rows(owner).find((r) => r.id === id && r.values['tl1.row'] === 'exception');
  if (!row) return;
  const group = w.rows(owner).filter((r) => r.values['tl1.subject'] === id);
  const refs = (kind: string): Exact[] =>
    group
      .filter((r) => r.values['tl1.row'] === kind)
      .map(
        (r) =>
          ({
            type: 'exact',
            ...Object.fromEntries(
              ['artifact', 'version', 'hash', 'item', 'facet'].flatMap((k) =>
                typeof r.values['tl1.ref.' + k] === 'string' ? [[k, r.values['tl1.ref.' + k]]] : [],
              ),
            ),
          }) as Exact,
      );
  const basis = refs('exception-basis'),
    kind = String(row.values['tl1.diag']) as TimelineDiagnosticKind;
  const target = basis.find((r) => r.artifact === owner && r.item === row.values['tl1.subject']);
  const targets = kind === 'single-event' ? (target ? [target] : []) : refs('exception-target');
  if ([...targets, ...basis].some((r) => !w.readable(r.artifact))) return;
  return {
    story: w.links.story.id,
    kind,
    scope: String(row.values['tl1.scope']),
    rule: String(row.values['tl1.rule']),
    reason: String(row.values['tl1.reason']),
    targets,
    basis,
    ...(row.values['tl1.hypothesis'] ? { hypothesis: String(row.values['tl1.hypothesis']) } : {}),
  };
}
export function diagnosticExceptionInput(
  story: string,
  d: TimelineDiagnostic,
  reason: string,
): TimelineExceptionInput {
  return {
    story,
    kind: d.kind,
    scope: 'story:' + story,
    rule: d.rule,
    targets: structuredClone(d.targets),
    basis: d.basis.map((b) => structuredClone(b.exact)),
    reason,
  };
}
/** Compare verified native row/facet meaning, retaining both exact versions as evidence.
 * Whole-row references include native subject groups and their internal dependencies;
 * exception records are not domain prerequisites and do not invalidate themselves. */
export async function matchTimelineException(
  w: TimelineWorkbench,
  record: TimelineExceptionInput,
  current: Omit<TimelineExceptionInput, 'reason'>,
): Promise<'applies' | 'recheck'> {
  record = structuredClone(record);
  current = structuredClone(current);
  const story = canonicalJson(w.links.story);
  if (record.story !== w.links.story.id) return 'recheck';
  const meta = (v: Omit<TimelineExceptionInput, 'reason'>) =>
    canonicalJson([v.story, v.kind, v.scope, v.rule, v.hypothesis ?? null]);
  if (meta(record) !== meta(current) || !record.targets.length || !record.basis.length)
    return 'recheck';
  const all = [...record.targets, ...record.basis, ...current.targets, ...current.basis],
    epoch = w.accessEpoch;
  if (all.some((r) => !w.readable(r.artifact))) return 'recheck';
  const owners = [...new Set(all.map((r) => r.artifact))];
  const revisions = () =>
    canonicalJson(
      owners.map((id) => {
        const editor = w.owner(id)?.editor;
        return [id, editor?.revision ?? null, editor?.artifact.draft.baseVersionId ?? null];
      }),
    );
  const before = revisions();
  if (exceptionMatches(record, current) === 'applies') return 'applies';
  const cache = new Map<string, Promise<string | undefined>>();
  const meaning = (r: Exact) => {
    const key = canonicalJson(r);
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        if (!w.readable(r.artifact)) return;
        const a = await w.source.get(r.artifact),
          found = a?.versions.filter((v) => v.versionId === r.version);
        if (a?.id !== r.artifact || found?.length !== 1) return;
        const v = found[0];
        if (v.contentHash !== r.hash || (await contentHash(v.content)) !== r.hash) return;
        const table = (['ledger', 'world', 'composition', 'scene-cards'] as TimelineRole[])
          .map((role) => readTimelineTable(role, v.content))
          .find((t) => t.state === 'valid');
        if (!table || table.state !== 'valid') return;
        const rows = new Map(table.rows.map((row) => [row.id, row])),
          visited = new Set<string>();
        const visit = (id: string) => {
          if (visited.has(id)) return;
          const row = rows.get(id);
          if (!row || row.kind.startsWith('exception')) return;
          visited.add(id);
          if (typeof row.cells['tl1.subject'] === 'string') visit(row.cells['tl1.subject']);
          for (const child of table.rows)
            if (child.cells['tl1.subject'] === id && !child.kind.startsWith('exception'))
              visit(child.id);
          for (const ref of [row.ref, row.ref2]) if (ref?.type === 'internal') visit(ref.item);
        };
        visit(r.item);
        if (!visited.has(r.item)) return;
        return canonicalJson([
          table.role,
          [...visited].sort().map((id) => ({ id, cells: rows.get(id)!.cells })),
        ]);
      })();
      cache.set(key, pending);
    }
    return pending;
  };
  const sameSet = async (old: Exact[], next: Exact[]) => {
    if (old.length !== next.length) return false;
    const remaining = [...next];
    for (const ref of old) {
      const identity = (r: Exact) =>
        r.artifact === ref.artifact &&
        r.item === ref.item &&
        (r.facet ?? null) === (ref.facet ?? null);
      let index = remaining.findIndex((r) => canonicalJson(r) === canonicalJson(ref));
      if (index < 0) {
        const value = await meaning(ref);
        if (value === undefined) return false;
        for (let i = 0; i < remaining.length; i++)
          if (identity(remaining[i]) && (await meaning(remaining[i])) === value) {
            index = i;
            break;
          }
      }
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return true;
  };
  try {
    const equal =
      (await sameSet(record.targets, current.targets)) &&
      (await sameSet(record.basis, current.basis));
    return equal &&
      story === canonicalJson(w.links.story) &&
      epoch === w.accessEpoch &&
      before === revisions() &&
      all.every((r) => w.readable(r.artifact))
      ? 'applies'
      : 'recheck';
  } catch {
    return 'recheck';
  }
}
