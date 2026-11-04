import { useEffect, useState } from 'react';
import type { Notice } from './edit';
import type { TimelineSavePlan, TimelineSaveReceipt, TimelineSaveRecovery } from './save-recovery';
export function SaveRecoveryView({
  recovery: r,
  notify,
}: {
  recovery: TimelineSaveRecovery;
  notify(n: Notice): void;
}) {
  const w = r.workbench,
    owner = w.owner(w.links.story.composition);
  const [receipts, setReceipts] = useState<TimelineSaveReceipt[]>([]);
  const [plan, setPlan] = useState<TimelineSavePlan>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    void r
      .list()
      .then((rows) => {
        if (live) setReceipts(rows);
      })
      .catch(() => {
        if (live) notify({ ok: false, text: '保存復旧記録を読み込めません。' });
      });
    return () => {
      live = false;
    };
  }, [r, reload, w.revision]); // notify is an inline Host setter; loading does not rerun on render.
  const run = async (work: () => Promise<unknown>) => {
    if (!owner) return;
    const current = w.captureAccess(owner.id);
    setBusy(true);
    try {
      const result = await work();
      if (
        current() &&
        result &&
        typeof result === 'object' &&
        'state' in result &&
        result.state === 'complete'
      )
        notify({ ok: true, text: '本体の保存と原稿対応の更新を確認しました。' });
    } catch (e) {
      if (current()) notify({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  };
  if (!owner) return null;
  return (
    <section className="tl-repin" aria-label="保存と原稿対応の復旧">
      <h3>保存と原稿対応の復旧</h3>
      <p>
        構成の保存版に原稿対応を結び直します。原稿本文・章順は変更しません。本体の保存と対応表の更新は別段階です。
      </p>
      <button
        type="button"
        disabled={busy || owner.editor.readOnly || !!plan}
        onClick={() => void run(async () => setPlan(await r.prepare(owner.id)))}
      >
        構成を保存して原稿対応を更新
      </button>{' '}
      <button
        type="button"
        disabled={busy || owner.editor.readOnly || !!plan}
        onClick={() => void run(async () => setPlan(await r.prepareReconnect(owner.id)))}
      >
        記録なしの再接続を確認
      </button>
      {plan && (
        <div role="group" aria-label="保存対象の確認">
          <p>
            {owner.name}：
            {plan.receipt.savedVersionId
              ? `保持版 ${plan.receipt.savedVersionId} へ再接続`
              : '現在の確定済み下書きを保存'}
            。対応する提示位置：
            {plan.receipt.expected.occurrenceLinks
              .filter((l) => plan.receipt.linkIds.includes(l.id))
              .map((l) => l.occurrence.itemId)
              .join('、')}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const selected = plan;
                setPlan(undefined);
                return r.commit(selected);
              })
            }
          >
            この内容で保存・接続
          </button>{' '}
          <button type="button" disabled={busy} onClick={() => setPlan(undefined)}>
            取消
          </button>
        </div>
      )}
      {busy && <p role="status">保存状態を確認しています。</p>}
      <ul>
        {receipts
          .filter((item) => w.readable(item.owner))
          .map((item) => (
            <li
              key={item.operationId}
              data-save-operation={item.operationId}
              data-save-state={item.state}
            >
              {item.state === 'unsaved'
                ? '未保存・保存結果の確認待ち'
                : item.state === 'source-saved-links-pending'
                  ? '本体は保存済み・原稿対応の更新待ち'
                  : '本体・原稿対応とも保存済み'}
              {item.savedVersionId && <span>（{item.savedVersionId}）</span>}
              {item.state !== 'complete' && (
                <>
                  <button
                    type="button"
                    disabled={busy || owner.editor.readOnly}
                    onClick={() => void run(() => r.retry(item.operationId))}
                  >
                    {item.state === 'unsaved' ? '本体の保存を再試行' : '対応表だけ再試行'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || owner.editor.readOnly}
                    onClick={() => void run(() => r.recover(item.operationId))}
                  >
                    保持版を照合して復旧
                  </button>
                </>
              )}
            </li>
          ))}
      </ul>
    </section>
  );
}
