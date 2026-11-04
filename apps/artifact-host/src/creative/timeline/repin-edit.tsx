/** Explicit saved-version choices; one owner's existing form/command/history boundary. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { timelineRepinProgress } from './repin-progress';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditForm, Field, type Notice } from './edit';
import { exactRefCells, type TimelineExactRef, type TimelineRepinManifest } from './repin';
import type { TimelineWorkbench } from './workbench';
type Choice = {
  row: string;
  ref: 'ref' | 'ref2';
  old: TimelineExactRef;
  options: TimelineExactRef[];
};
type Preview = { manifest: TimelineRepinManifest; choices: Choice[]; current(): boolean };
export function RepinEdit({
  workbench: w,
  notify,
}: {
  workbench: TimelineWorkbench;
  notify(n: Notice): void;
}) {
  const [ownerId, setOwnerId] = useState('');
  const progress = useMemo(() => timelineRepinProgress(w), [w]);
  const [, refresh] = useState(0);
  const [saving, setSaving] = useState('');
  const prepared = useRef<TimelineRepinManifest | undefined>(undefined);
  const [preview, setPreview] = useState<Preview>();
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [lifetime] = useState(() => ({ generation: 0 }));
  useEffect(
    () => () => {
      lifetime.generation++;
    },
    [lifetime],
  );
  const owners = ['ledger', 'scene-cards', 'composition', 'world'] as const;
  const owner = w.owner(ownerId);
  const close = () => {
    lifetime.generation++;
    setPreview(undefined);
    setSelection({});
    setLoading(false);
  };
  const open = async () => {
    if (!owner || owner.editor.readOnly) return;
    const generation = ++lifetime.generation;
    const current = w.captureAccess(owner.id);
    const manifest: TimelineRepinManifest = {
      owner: owner.id,
      baseVersion: owner.editor.artifact.draft.baseVersionId,
      baseLocalRevision: owner.editor.revision,
      rows: [],
    };
    const rows = w.rows(owner.id);
    setLoading(true);
    try {
      const choices: Choice[] = [];
      const targets = new Map<string, Awaited<ReturnType<typeof w.source.get>>>();
      for (const row of rows) {
        if (
          ['ref', 'ref2'].some((ref) => {
            const id = row.values['tl1.' + ref + '.artifact'];
            return typeof id === 'string' && !w.readable(id);
          })
        )
          continue;
        for (const ref of ['ref', 'ref2'] as const) {
          const old = exactRefCells(row.values, ref);
          if (!old || !w.readable(old.artifact)) continue;
          if (!targets.has(old.artifact))
            targets.set(old.artifact, await w.source.get(old.artifact));
          if (!current() || lifetime.generation !== generation) return;
          const a = targets.get(old.artifact);
          if (!a || !w.readable(old.artifact)) continue;
          choices.push({
            row: row.id,
            ref,
            old,
            options: a.versions
              .map((v) => ({
                ...old,
                version: v.versionId,
                hash: v.contentHash,
              }))
              .filter((v) => canonicalJson(v) !== canonicalJson(old)),
          });
        }
      }
      if (current() && lifetime.generation === generation) {
        const readable = choices.map((c) => w.captureAccess(c.old.artifact));
        setPreview({ manifest, choices, current: () => current() && readable.every((r) => r()) });
        setSelection({});
      }
    } catch {
      if (current() && lifetime.generation === generation)
        notify({ ok: false, text: '保存版を取得できません。再読込してください。' });
    } finally {
      if (lifetime.generation === generation) setLoading(false);
    }
  };
  const live = preview?.current() && owner && !owner.editor.readOnly ? preview : undefined;
  return (
    <section className="tl-repin" aria-label="保存版の再固定">
      <h3>保存版の再固定</h3>
      <p>
        同じ資料・項目の参照版だけを選び直します。選択した参照を一つの資料にまとめて確定し、その資料の「元に戻す」で戻せます。
      </p>
      <Field label="再固定する資料">
        {(id) => (
          <select
            id={id}
            value={ownerId}
            disabled={!!live || loading}
            onChange={(e) => {
              close();
              setOwnerId(e.currentTarget.value);
            }}
          >
            <option value="">選んでください</option>
            {owners
              .flatMap((role) => w.ownersOf(role))
              .filter((o) => !o.editor.readOnly)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </select>
        )}
      </Field>
      <button
        type="button"
        disabled={!owner || owner.editor.readOnly || !!live || loading}
        onClick={() => void open()}
      >
        保存版を選び直す
      </button>
      {loading && <p role="status">保存版を読み込んでいます。</p>}
      {live && owner && (
        <EditForm
          owner={owner}
          title="参照版を一括再固定"
          dirty={Object.values(selection).some(Boolean)}
          closeUnchanged
          cancel={close}
          success={() => {
            if (prepared.current) progress.recordApplied(prepared.current);
            prepared.current = undefined;
            refresh((n) => n + 1);
            notify({
              ok: true,
              text: '選択した参照版を再固定しました。保存は資料ごとに確認してください。',
            });
          }}
          validate={async (signal) => {
            const manifest: TimelineRepinManifest = {
              ...live.manifest,
              rows: live.choices.flatMap((c) => {
                const value = selection[JSON.stringify([c.row, c.ref])];
                return value
                  ? [
                      {
                        row: c.row,
                        ref: c.ref,
                        old: c.old,
                        new: JSON.parse(value) as TimelineExactRef,
                      },
                    ]
                  : [];
              }),
            };
            const cmd = await w.prepareRepin(manifest, signal);
            prepared.current = structuredClone(manifest);
            return cmd;
          }}
        >
          <p>
            旧版から選択版への差分を確認して確定してください。資料が変わった場合は取消後に選び直します。最新版は自動採用しません。
          </p>
          {live.choices.length === 0 && <p>表示できる固定参照がありません。</p>}
          {live.choices.map((c) => {
            const key = JSON.stringify([c.row, c.ref]);
            return (
              <Field
                key={key}
                label={`${c.row} ${c.ref} · ${c.old.artifact} / ${c.old.item}（旧版 ${c.old.version}）`}
              >
                {(id) => (
                  <select
                    id={id}
                    value={selection[key] ?? ''}
                    onChange={(e) => setSelection({ ...selection, [key]: e.currentTarget.value })}
                  >
                    <option value="">変更しない</option>
                    {c.options.map((r) => (
                      <option key={canonicalJson(r)} value={canonicalJson(r)}>
                        → 保存版 {r.version} · {r.hash}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            );
          })}
        </EditForm>
      )}
      {progress.list().length > 0 && (
        <section aria-label="資料ごとの再固定結果">
          <h4>資料ごとの再固定結果</h4>
          <p>他の資料の失敗で完了分を戻しません。失敗した資料だけ保存を再試行できます。</p>
          {progress.list().map((r) => (
            <div key={r.id} data-repin-owner={r.manifest.owner} data-repin-state={r.state}>
              <p>
                {w.owner(r.manifest.owner)?.name}：
                {r.state === 'saved'
                  ? `保存済み（${r.versionId}）`
                  : r.state === 'save-failed'
                    ? '保存失敗・再固定は確定済み'
                    : '再固定は確定済み・未保存'}
              </p>
              {r.state !== 'saved' && (
                <button
                  type="button"
                  disabled={!!saving || !w.editable(r.manifest.owner)}
                  onClick={async () => {
                    const current = w.captureAccess(r.manifest.owner);
                    setSaving(r.id);
                    try {
                      await progress.save(r.id);
                    } catch (e) {
                      if (current()) notify({ ok: false, text: String(e) });
                    } finally {
                      setSaving('');
                      refresh((n) => n + 1);
                    }
                  }}
                >
                  {w.owner(r.manifest.owner)?.name} の再固定結果を保存
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
