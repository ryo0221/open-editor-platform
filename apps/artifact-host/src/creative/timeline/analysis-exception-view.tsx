import { useMemo, useState, useEffect, useRef } from 'react';
import {
  TimelineExceptionRecorder,
  exceptionMatches,
  exceptionOwner,
  readTimelineException,
  diagnosticExceptionInput,
  matchTimelineException,
} from './analysis-exceptions';
import type { TimelineDiagnostic } from './analysis-semantics';
import type { TimelineWorkbench } from './workbench';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditForm, Field, type Notice } from './edit';
export { diagnosticExceptionInput } from './analysis-exceptions';
export function TimelineExceptionView({
  workbench: w,
  diagnostic,
  diagnostics,
  current,
  notify,
  done,
}: {
  workbench: TimelineWorkbench;
  diagnostic?: TimelineDiagnostic;
  diagnostics: TimelineDiagnostic[];
  current(): boolean;
  notify(n: Notice): void;
  done(): void;
}) {
  const recorder = useMemo(() => new TimelineExceptionRecorder(w), [w]),
    [reason, setReason] = useState('');
  const input = diagnostic
    ? diagnosticExceptionInput(w.links.story.id, diagnostic, reason)
    : undefined;
  let owner: ReturnType<TimelineWorkbench['owner']>;
  try {
    if (input) owner = w.owner(exceptionOwner(w, { ...input, reason: reason || '確認' }));
  } catch {
    owner = undefined;
  }
  const rows = (['ledger', 'composition', 'world'] as const)
    .flatMap((role) => w.ownersOf(role))
    .flatMap((o) =>
      w
        .rows(o.id)
        .filter((row) => row.values['tl1.row'] === 'exception')
        .flatMap((row) => {
          const input = readTimelineException(w, o.id, row.id);
          if (!input) return [];
          return [{ id: row.id, owner: o.name, ownerId: o.id, input }];
        }),
    );
  const key = canonicalJson([rows, diagnostics, current(), w.accessEpoch]);
  const [matches, setMatches] = useState<{ key: string; states: Record<string, string> }>();
  const latest = useRef({ rows, diagnostics, current });
  latest.current = { rows, diagnostics, current };
  useEffect(() => {
    const { rows, diagnostics, current } = latest.current;
    let active = true;
    void (async () => {
      const states: Record<string, string> = {};
      for (const row of rows) {
        const candidates = diagnostics
          .filter((d) => d.kind === row.input.kind)
          .map((d) => diagnosticExceptionInput(w.links.story.id, d, ''));
        let state = 'recheck';
        for (const candidate of candidates)
          if ((await matchTimelineException(w, row.input, candidate)) === 'applies') {
            state = 'applies';
            break;
          }
        states[row.ownerId + '#' + row.id] = state;
      }
      if (active && current()) setMatches({ key, states });
    })();
    return () => {
      active = false;
    };
  }, [w, key]);
  return (
    <section aria-label="診断ごとの例外">
      <h3>診断ごとの例外</h3>
      <p>
        例外は警告を一括抑止しません。診断kindと開始時のStoryから保存先を決めます。対象・根拠・範囲・ruleが変われば再確認します。
      </p>
      {rows.map((r) => {
        const strict = diagnostics.some(
          (d) =>
            exceptionMatches(r.input, diagnosticExceptionInput(w.links.story.id, d, '')) ===
            'applies',
        );
        const state = current()
          ? strict
            ? 'applies'
            : matches?.key === key
              ? matches.states[r.ownerId + '#' + r.id]
              : 'checking'
          : 'recheck';
        return (
          <p key={r.owner + r.id} data-exception={r.id} data-exception-state={state}>
            {r.owner} · {r.id}：
            {state === 'applies'
              ? 'この診断に適用可能'
              : state === 'checking'
                ? '根拠を確認しています'
                : '再確認が必要'}{' '}
            · {r.input.reason}
          </p>
        );
      })}
      {diagnostic &&
        input &&
        (owner &&
        w.editable(owner.id) &&
        [...input.targets, ...input.basis].every((ref) => w.readable(ref.artifact)) ? (
          <EditForm
            key={diagnostic.site}
            owner={owner}
            title="例外を記録"
            dirty
            validate={async (signal) => {
              if (!current())
                throw Error('診断の前提が変わりました。入力を取消して再診断してください。');
              return recorder.nativeCommand(await recorder.prepare(input, signal, current));
            }}
            cancel={() => {
              setReason('');
              done();
            }}
            success={() =>
              notify({ ok: true, text: '例外を確定しました。資料の保存は別操作です。' })
            }
          >
            {!current() && (
              <p role="alert">
                診断の前提が変わったため確定できません。理由を確認して取消してください。
              </p>
            )}
            <p>
              {diagnostic.site} の例外。保存先：{owner.name}
              。確定後はこの資料の未保存の変更になります。
            </p>
            <Field label="この診断を例外とする理由">
              {(id) => (
                <input id={id} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
              )}
            </Field>
          </EditForm>
        ) : (
          <div>
            <p role="note">この診断kindの保存先を編集できません。別の資料へ退避しません。</p>
            <button
              type="button"
              onClick={() => {
                setReason('');
                done();
              }}
            >
              例外入力を取消
            </button>
          </div>
        ))}
    </section>
  );
}
