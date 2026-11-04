import { useEffect, useState } from 'react';
import { newId } from '@editor-platform/artifact-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import { type DesignContent, type DesignElement } from './model';
import { DesignPagePanel } from './page-panel';
import {
  designDivisionCommand,
  materializeDivision,
  type DesignDivisionOperation,
} from './division';
import './manga-workspace.css';
import { mangaEditingContext } from './manga-context';
export function MangaPanel({
  onRead,
  splitRequest,
  onDrawSplit,
  content,
  selected,
  currentPageId,
  readOnly,
  apply,
  choose,
  fit,
  preview: showPreview,
}: {
  onRead(mode: 'spread' | 'all', pageId: string): void;
  splitRequest?: { op: DesignDivisionOperation; base: DesignContent };
  onDrawSplit(): void;
  content: DesignContent;
  selected: string[];
  currentPageId?: string;
  readOnly: boolean;
  apply: (cmd: EditorCommand<DesignContent>) => boolean;
  choose: (ids: string[]) => void;
  fit: (ids?: string[]) => void;
  preview: (value?: DesignContent) => void;
}) {
  const { page, frame, panel } = mangaEditingContext(content, selected, currentPageId);
  const panelId = panel?.id;
  const [angle, setAngle] = useState('90'),
    [gap, setGap] = useState('16'),
    [offset, setOffset] = useState(''),
    [retain, setRetain] = useState<'a' | 'b'>('a'),
    [insert, setInsert] = useState<'after' | 'before'>('after');
  const [dividerId, setDividerId] = useState(''),
    [error, setError] = useState('');
  const [pending, setPending] = useState<{ base: DesignContent; op: DesignDivisionOperation }>();
  const geometry =
    page?.division && frame ? materializeDivision(page.division, frame.bounds) : undefined;
  const divider =
    geometry?.dividers.find((d) => d.dividerId === dividerId) ?? geometry?.dividers[0];
  useEffect(() => {
    setPending(undefined);
    showPreview(undefined);
  }, [content]);
  useEffect(() => {
    if (splitRequest?.base === content) preview(splitRequest.op);
  }, [splitRequest]);
  function preview(op: DesignDivisionOperation) {
    try {
      const next = designDivisionCommand(op).apply(content);
      setPending({ base: content, op });
      showPreview(next);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function line(target: DesignElement) {
    const degrees = Number(angle);
    if (!Number.isFinite(degrees) || Math.abs(degrees) > 360)
      throw Error('角度は -360〜360 度です');
    const rad = (degrees * Math.PI) / 180,
      nx = Math.cos(rad),
      ny = Math.sin(rad);
    return {
      nx,
      ny,
      offset: offset.trim()
        ? Number(offset)
        : nx * (target.bounds.x - frame!.bounds.x + target.bounds.width / 2) +
          ny * (target.bounds.y - frame!.bounds.y + target.bounds.height / 2),
    };
  }
  return (
    <section className="manga-panel" aria-label="Manga pages and panels">
      <h2>漫画</h2>
      <p>コマの分割 → 境界の調整 → 台詞・作画 → 通読</p>
      <nav aria-label="Manga page navigation">
        {content.pagination?.pages.map((p, i) => (
          <button
            key={p.frameId}
            aria-pressed={p === page}
            onClick={() => {
              choose([p.frameId]);
              fit([p.frameId]);
            }}
          >
            ページ {i + 1}
          </button>
        ))}
      </nav>
      <div className="manga-view-controls">
        <button disabled={!page} onClick={() => fit(page ? [page.frameId] : undefined)}>
          単ページ
        </button>
        <button disabled={!page} onClick={() => onRead('spread', page!.frameId)}>
          見開き
        </button>
        <button disabled={!page} onClick={() => onRead('all', page!.frameId)}>
          通読
        </button>
      </div>
      {!page && (
        <p>
          ページ未設定です。下の「Add page」でページを用意できます。切替だけでは原稿を変更しません。
        </p>
      )}
      {content.elements.some(
        (e) => !e.parentId && !content.pagination?.pages.some((p) => p.frameId === e.id),
      ) && <p>ページ外にも要素があります。Designで詳細編集から確認できます。</p>}
      {frame && page && (
        <fieldset disabled={readOnly}>
          <legend>コマ割り</legend>
          {!page.division ? (
            <>
              <p>ページ全体のコマを共有境界で連動させます。</p>
              <button
                disabled={page.panelIds.length > 1}
                onClick={() =>
                  preview({
                    type: 'startDivision',
                    pageId: page.frameId,
                    region: {
                      x: 30,
                      y: 30,
                      width: frame.bounds.width - 60,
                      height: frame.bounds.height - 60,
                    },
                    root: { panelId: panelId ?? newId('panel') },
                  })
                }
              >
                連動コマ割りをプレビュー
              </button>
              {page.panelIds.length > 1 && (
                <p>複数の既存コマは自動で分割木に変換しません。新しいページから始めてください。</p>
              )}
            </>
          ) : (
            <>
              <p>枠の変更では、中の絵・文字の位置を保ちます。</p>
              <button
                onClick={() => {
                  setPending(undefined);
                  showPreview(undefined);
                  onDrawSplit();
                }}
              >
                線を引いて分割
              </button>
              <label>
                分割するコマ
                <select
                  aria-label="分割するコマ"
                  value={panelId ?? ''}
                  onChange={(e) => choose([e.target.value])}
                >
                  {page.panelIds.map((id, i) => (
                    <option key={id} value={id}>
                      コマ {i + 1}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                境界の法線角度
                <input
                  aria-label="境界の法線角度"
                  type="number"
                  value={angle}
                  onChange={(e) => setAngle(e.target.value)}
                />
              </label>
              <p>90°: 横に分割 / 0°: 縦に分割 / その他: 斜め</p>
              <label>
                コマ間隔
                <input
                  aria-label="コマ間隔"
                  type="number"
                  min="0"
                  value={gap}
                  onChange={(e) => setGap(e.target.value)}
                />
              </label>
              <label>
                境界位置
                <input
                  aria-label="境界位置"
                  type="number"
                  placeholder="選んだコマの中央"
                  value={offset}
                  onChange={(e) => setOffset(e.target.value)}
                />
              </label>
              <label>
                絵を残す側
                <select
                  aria-label="絵を残す側"
                  value={retain}
                  onChange={(e) => setRetain(e.target.value as 'a' | 'b')}
                >
                  <option value="a">上 / 左（a）</option>
                  <option value="b">下 / 右（b）</option>
                </select>
              </label>
              <label>
                新コマの読み順
                <select
                  aria-label="新コマの読み順"
                  value={insert}
                  onChange={(e) => setInsert(e.target.value as 'after' | 'before')}
                >
                  <option value="after">元のコマの後</option>
                  <option value="before">元のコマの前</option>
                </select>
              </label>
              <button
                onClick={() => {
                  try {
                    preview({
                      type: 'splitPanel',
                      pageId: page.frameId,
                      panelId: panelId!,
                      newPanelId: newId('panel'),
                      dividerId: newId('divider'),
                      line: line(panel!),
                      gap: Number(gap),
                      retain,
                      insert,
                    });
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                分割をプレビュー
              </button>
              {divider && (
                <>
                  <label>
                    編集する境界
                    <select
                      aria-label="編集する境界"
                      value={divider.dividerId}
                      onChange={(e) => setDividerId(e.target.value)}
                    >
                      {geometry!.dividers.map((d, i) => (
                        <option key={d.dividerId} value={d.dividerId}>
                          境界 {i + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    onClick={() => {
                      setAngle(
                        String((Math.atan2(divider.line.ny, divider.line.nx) * 180) / Math.PI),
                      );
                      setGap(String(divider.gap));
                      setOffset(String(divider.line.offset));
                    }}
                  >
                    境界の値を読み込む
                  </button>
                  <button
                    onClick={() => {
                      try {
                        preview({
                          type: 'setDivider',
                          pageId: page.frameId,
                          dividerId: divider.dividerId,
                          line: line(panel!),
                          gap: Number(gap),
                        });
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    境界変更をプレビュー
                  </button>
                  <button
                    onClick={() =>
                      preview({
                        type: 'mergePanels',
                        pageId: page.frameId,
                        dividerId: divider.dividerId,
                        retainPanelId: panelId!,
                      })
                    }
                  >
                    選択コマへ結合をプレビュー
                  </button>
                </>
              )}
              <button onClick={() => preview({ type: 'detachDivision', pageId: page.frameId })}>
                このページの連動解除をプレビュー
              </button>
            </>
          )}
        </fieldset>
      )}
      {pending && (
        <div role="region" aria-label="コマ割りプレビュー" className="manga-preview">
          <p>プレビュー中。読み順の番号と切り取り範囲を確認してください。</p>
          <button
            disabled={readOnly || pending.base !== content}
            onClick={() => {
              if (pending.base !== content) return;
              if (apply(designDivisionCommand(pending.op))) {
                setPending(undefined);
                showPreview(undefined);
              }
            }}
          >
            このコマ割りを採用
          </button>
          <button
            onClick={() => {
              setPending(undefined);
              showPreview(undefined);
            }}
          >
            プレビューを取り消す
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <DesignPagePanel
        content={content}
        apply={apply}
        choose={choose}
        readOnly={readOnly || !!pending}
      />
    </section>
  );
}
