import { useEffect, useMemo, useRef, useState } from 'react';
import { Field, type Notice } from './edit';
import { timelineTwoStep, type TimelineConnectionPreview } from './two-step';
import type { TimelineWorkbench } from './workbench';
export function TwoStepView({
  workbench: w,
  notify,
}: {
  workbench: TimelineWorkbench;
  notify(n: Notice): void;
}) {
  const flow = useMemo(() => timelineTwoStep(w), [w]);
  const [, refresh] = useState(0);
  const [source, setSource] = useState('');
  const [active, setActive] = useState('');
  const [target, setTarget] = useState('');
  const [order, setOrder] = useState('100');
  const [part, setPart] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingInput, setPendingInput] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const [confirmation, setConfirmation] = useState<TimelineConnectionPreview>();
  const [controller, setController] = useState<AbortController>();
  useEffect(() => () => controller?.abort(), [controller]);
  const records = flow.list(),
    current = records.find((r) => r.sourceOperationId === active);
  const guard = useRef(false);
  guard.current = pendingInput || busy || !!confirmation;
  useEffect(() => {
    if (current?.state !== 'source-saved-unlinked') return;
    return w.owner(current.sourceOwner)?.forms.register({
      dirty: () => guard.current,
      prepare() {
        throw Error('接続先の入力を確認・確定または取消してください。');
      },
      consume() {},
      finalize() {},
      focus() {
        panel.current?.querySelector<HTMLElement>('input, select')?.focus();
      },
    });
  }, [w, current?.sourceOwner, current?.state]);
  const run = async (work: () => Promise<void>) => {
    const readable = current ? w.captureAccess(current.sourceOwner) : () => true;
    setBusy(true);
    try {
      await work();
    } catch (e) {
      if (readable()) notify({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      refresh((n) => n + 1);
    }
  };
  const sources = [...w.ownersOf('ledger'), ...w.ownersOf('scene-cards')]
    .filter((o) => !o.editor.readOnly)
    .flatMap((o) =>
      w
        .rows(o.id)
        .filter((r) => r.values['tl1.row'] === 'event' || r.values['tl1.row'] === 'scene')
        .map((r) => ({
          value: JSON.stringify([o.id, r.id]),
          label: `${o.name} · ${r.id} ${String(r.values['tl1.label'] ?? '')}`,
        })),
    );
  const scenes = w
    .ownersOf('scene-cards')
    .filter((o) => !o.editor.readOnly)
    .flatMap((o) =>
      w
        .rows(o.id)
        .filter((r) => r.values['tl1.row'] === 'scene')
        .map((r) => ({ value: JSON.stringify([o.id, r.id]), label: `${o.name} · ${r.id}` })),
    );
  const reset = () => {
    controller?.abort();
    setConfirmation(undefined);
    setController(undefined);
  };
  return (
    <section ref={panel} className="tl-repin" aria-label="保存して引用・配置">
      <h3>保存して引用・配置</h3>
      <p>
        作成した出来事・場面を選び、第一段階で保存します。第二段階の取消・失敗でも元の資料は残ります。
      </p>
      <Field label="保存する出来事・場面">
        {(id) => (
          <select
            id={id}
            value={source}
            disabled={busy || !!current}
            onChange={(e) => setSource(e.currentTarget.value)}
          >
            <option value="">選んでください</option>
            {sources.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <button
        type="button"
        disabled={busy || !!current || !source}
        onClick={() => {
          const [owner, item] = JSON.parse(source) as string[];
          try {
            const r = flow.begin(owner, item);
            setActive(r.sourceOperationId);
            setTarget('');
            refresh((n) => n + 1);
          } catch (e) {
            notify({ ok: false, text: String(e) });
          }
        }}
      >
        この項目で進める
      </button>
      {current && (
        <div data-two-step-state={current.state}>
          <p>
            {current.item}：
            {current.state === 'source-unsaved'
              ? '第一段階・元の資料は未保存'
              : current.state === 'source-saved-unlinked'
                ? current.kind === 'event'
                  ? '保存済み・SC未接続'
                  : '保存済み・構成に未配置'
                : current.state === 'connection-unsaved'
                  ? '第二段階・関連付けは未保存'
                  : '第二段階まで保存済み'}
            {current.saved && `（保存版 ${current.saved.versionId}）`}
          </p>
          {current.state === 'source-unsaved' && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await flow.saveSource(active);
                })
              }
            >
              元の資料を保存
            </button>
          )}
          {current.state === 'source-saved-unlinked' && (
            <>
              {current.kind === 'event' ? (
                <Field label="引用する場面">
                  {(id) => (
                    <select
                      id={id}
                      value={target}
                      disabled={busy || !!confirmation}
                      onChange={(e) => {
                        reset();
                        setTarget(e.currentTarget.value);
                        setPendingInput(true);
                      }}
                    >
                      <option value="">選んでください</option>
                      {scenes.map((x) => (
                        <option key={x.value} value={x.value}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : (
                <>
                  <Field label="新しい提示順">
                    {(id) => (
                      <input
                        id={id}
                        value={order}
                        disabled={busy || !!confirmation}
                        onChange={(e) => {
                          reset();
                          setOrder(e.currentTarget.value);
                          setPendingInput(true);
                        }}
                      />
                    )}
                  </Field>
                  <Field label="新しい話・章">
                    {(id) => (
                      <input
                        id={id}
                        value={part}
                        disabled={busy || !!confirmation}
                        onChange={(e) => {
                          reset();
                          setPart(e.currentTarget.value);
                          setPendingInput(true);
                        }}
                      />
                    )}
                  </Field>
                </>
              )}
              <button
                type="button"
                disabled={busy || !!confirmation || (current.kind === 'event' && !target)}
                onClick={() =>
                  void run(async () => {
                    reset();
                    const abort = new AbortController();
                    setController(abort);
                    const connection =
                      current.kind === 'event'
                        ? (() => {
                            const [owner, scene] = JSON.parse(target) as string[];
                            return { owner, scene };
                          })()
                        : {
                            owner: w.links.story.composition,
                            order: Number(order),
                            part,
                            label: `${part} ${current.item}`.trim(),
                          };
                    const p = await flow.prepareConnection(active, connection, abort.signal);
                    if (!abort.signal.aborted) setConfirmation(p);
                  })
                }
              >
                接続先を確認
              </button>
              {(busy || confirmation || pendingInput) && (
                <button
                  type="button"
                  onClick={() => {
                    reset();
                    setPendingInput(false);
                  }}
                >
                  接続確認を取消
                </button>
              )}
              {confirmation && (
                <div role="group" aria-label="第二段階の確認">
                  <p>{confirmation.row.id} を作成します。保存済みの第一段階は変更しません。</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      try {
                        flow.commitConnection(confirmation);
                        setPendingInput(false);
                        reset();
                        refresh((n) => n + 1);
                      } catch (e) {
                        notify({ ok: false, text: String(e) });
                        reset();
                      }
                    }}
                  >
                    関連付けを確定
                  </button>
                </div>
              )}
            </>
          )}
          {current.state === 'connection-unsaved' && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await flow.saveConnection(active);
                })
              }
            >
              関連付けの保存だけ再試行
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              reset();
              setActive('');
              setPendingInput(false);
            }}
          >
            この操作を閉じる
          </button>
        </div>
      )}
      {records
        .filter((r) => r.sourceOperationId !== active)
        .map((r) => (
          <p key={r.sourceOperationId}>
            {r.item}：{r.state === 'complete' ? '保存済み' : '未完了の段階があります'}{' '}
            <button
              type="button"
              disabled={busy || !!current}
              onClick={() => {
                reset();
                setActive(r.sourceOperationId);
              }}
            >
              この操作を再開
            </button>
          </p>
        ))}
    </section>
  );
}
