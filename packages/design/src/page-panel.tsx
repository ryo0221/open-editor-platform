import { insertDesignPagePath, insertDesignSpeechBalloon } from './page-artwork';
import { newId } from '@editor-platform/artifact-core';
import { transaction, type Bounds, type EditorCommand } from '@editor-platform/editor-core';
import { insertElement, updateElement, type DesignContent } from './model';
import { insertDesignPage, insertDesignPanel, setDesignPagination } from './pagination';
import { mangaDialoguePlacement } from './manga-dialogue';
import {
  isMangaBalloon,
  isMangaKeepOut,
  mangaBalloonOverlaps,
  mangaSpeechBalloonPlacement,
  mangaPanelOf,
  moveMangaBalloonsOffKeepOut,
  setMangaKeepOut,
} from './manga-balloons';
import { useState } from 'react';

/** Generic native page controls, shared by ordinary and independent Design Surfaces. */
export function DesignPagePanel({
  content,
  apply,
  choose,
  readOnly,
  selected = [],
}: {
  content: DesignContent;
  apply: (cmd: EditorCommand<DesignContent>) => boolean;
  choose: (ids: string[]) => void;
  readOnly: boolean;
  /** The selection, for marking a face or figure that balloons keep off. */
  selected?: string[];
}) {
  const pagination = content.pagination;
  const [stuck, setStuck] = useState(0);
  const [locked, setLocked] = useState(0);
  const [noRoom, setNoRoom] = useState(false);
  const overlaps = mangaBalloonOverlaps(content);
  const target =
    selected.length === 1 ? content.elements.find((e) => e.id === selected[0]) : undefined;
  const markable =
    target && !isMangaBalloon(target) && mangaPanelOf(content, target.id) ? target : undefined;
  function moveBalloons() {
    const { command, stuck, locked } = moveMangaBalloonsOffKeepOut(content);
    setStuck(stuck.length);
    setLocked(locked.length);
    if (command) apply(command);
  }
  const [vertical, setVertical] = useState(false);
  function addPage() {
    const x = Math.max(0, ...content.elements.map((e) => e.bounds.x + e.bounds.width)) + 40;
    const cmd = insertDesignPage({ x, y: 0, width: 600, height: 800 });
    if (apply(cmd)) choose([cmd.elementId]);
  }
  function addPanel(pageId: string) {
    const page = content.elements.find((e) => e.id === pageId)!;
    const n = pagination!.pages.find((p) => p.frameId === pageId)!.panelIds.length;
    const cmd = insertDesignPanel(pageId, {
      x: page.bounds.x + 30,
      y: page.bounds.y + 30 + n * 230,
      width: 540,
      height: 210,
    });
    if (apply(cmd)) choose([cmd.elementId]);
  }
  function dialogue(panelId: string) {
    const panel = content.elements.find((e) => e.id === panelId)!;
    // Vertical dialogue is a tall box, fitted against every panel edge as it is (Codex on #29).
    const placement = vertical
      ? mangaDialoguePlacement(panel, 140, Math.min(400, panel.bounds.height * 0.8))
      : mangaDialoguePlacement(panel, 400);
    if (!placement) return;
    const id = newId('dialogue');
    const bounds = placement.bounds;
    const insert = insertElement('text', { id, parentId: panelId, bounds });
    if (
      apply(
        transaction('Insert dialogue', [
          insert,
          updateElement(id, {
            typography: vertical
              ? { ...placement.typography, writingMode: 'vertical-rl', align: 'center' }
              : placement.typography,
            text: 'Dialogue',
            fill: '#111111',
          }),
        ]),
      )
    )
      choose([id]);
  }
  function artwork(panelId: string, kind: 'line' | 'cubic' | 'balloon') {
    const panel = content.elements.find((e) => e.id === panelId)!;
    let bounds: Bounds | undefined = {
      x: panel.bounds.x + panel.bounds.width * 0.1,
      y: panel.bounds.y + panel.bounds.height * 0.1,
      width: panel.bounds.width * 0.7,
      height: panel.bounds.height * 0.65,
    };
    // A new balloon goes where it covers no face, figure or other balloon (#21); with no such
    // place it is not added, rather than put over one (Codex on #28).
    if (kind === 'balloon') {
      bounds = mangaSpeechBalloonPlacement(content, panelId, {
        width: panel.bounds.width * 0.4,
        height: panel.bounds.height * 0.4,
      });
      setNoRoom(!bounds);
      if (!bounds) return;
    }
    const cmd =
      kind === 'balloon'
        ? insertDesignSpeechBalloon(panelId, bounds, vertical ? '台詞' : 'Dialogue', { vertical })
        : insertDesignPagePath(panelId, kind, bounds);
    if (apply(cmd)) choose([cmd.elementId]);
  }
  return (
    <section aria-label="Page reading order">
      <h3>Pages</h3>
      <button disabled={readOnly} onClick={addPage}>
        Add page
      </button>
      {pagination && (
        <>
          <label>
            Reading direction{' '}
            <select
              aria-label="Reading direction"
              value={pagination.direction}
              disabled={readOnly}
              onChange={(e) =>
                apply(
                  setDesignPagination({
                    ...pagination,
                    direction: e.target.value as 'rtl' | 'ltr',
                  }),
                )
              }
            >
              <option value="rtl">Right to left</option>
              <option value="ltr">Left to right</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={vertical}
              disabled={readOnly}
              onChange={(e) => setVertical(e.target.checked)}
            />
            台詞を縦書きで入れる
          </label>
          <ol>
            {pagination.pages.map((p, index) => (
              <li key={p.frameId}>
                <button onClick={() => choose([p.frameId])}>{`Page ${index + 1}`}</button>
                <button
                  disabled={readOnly || !index}
                  aria-label={`Move page ${index + 1} earlier`}
                  onClick={() => {
                    const pages = [...pagination.pages];
                    [pages[index - 1], pages[index]] = [pages[index], pages[index - 1]];
                    apply(setDesignPagination({ ...pagination, pages }));
                  }}
                >
                  ↑
                </button>
                <button
                  disabled={readOnly || !!p.division}
                  onClick={() => addPanel(p.frameId)}
                  aria-label={`Add panel to page ${index + 1}`}
                >
                  Add panel
                </button>
                <ol>
                  {p.panelIds.map((id, i) => (
                    <li key={id}>
                      <button onClick={() => choose([id])}>{`Panel ${index + 1}.${i + 1}`}</button>
                      <button
                        disabled={readOnly || !i}
                        aria-label={`Move panel ${index + 1}.${i + 1} earlier`}
                        onClick={() => {
                          const panelIds = [...p.panelIds];
                          [panelIds[i - 1], panelIds[i]] = [panelIds[i], panelIds[i - 1]];
                          apply(
                            setDesignPagination({
                              ...pagination,
                              pages: pagination.pages.map((page) =>
                                page === p ? { ...page, panelIds } : page,
                              ),
                            }),
                          );
                        }}
                      >
                        ↑
                      </button>
                      <button
                        disabled={
                          readOnly ||
                          !mangaDialoguePlacement(content.elements.find((e) => e.id === id)!, 400)
                        }
                        title="小さすぎるコマには台詞を配置できません"
                        onClick={() => dialogue(id)}
                        aria-label={`Add dialogue to panel ${index + 1}.${i + 1}`}
                      >
                        Add dialogue
                      </button>
                      {(['line', 'cubic', 'balloon'] as const).map((kind) => (
                        <button
                          key={kind}
                          disabled={readOnly}
                          aria-label={`Add ${kind} to panel ${index + 1}.${i + 1}`}
                          onClick={() => artwork(id, kind)}
                        >
                          {kind === 'balloon'
                            ? 'Balloon with tail'
                            : kind === 'cubic'
                              ? 'Curve'
                              : 'Line'}
                        </button>
                      ))}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
          {markable && (
            <button
              disabled={readOnly}
              onClick={() => apply(setMangaKeepOut(markable.id, !isMangaKeepOut(markable)))}
            >
              {isMangaKeepOut(markable)
                ? '吹き出しを避ける範囲から外す'
                : '吹き出しを避ける範囲にする（顔・人物）'}
            </button>
          )}
          {!!overlaps.length && (
            <div role="alert" aria-label="Balloon overlaps">
              <p>{`吹き出しが顔・人物にかかっています（${overlaps.length} 件）`}</p>
              <ul>
                {overlaps.map((o) => (
                  <li key={`${o.balloonId}:${o.keepOutId}`}>
                    <button onClick={() => choose([o.balloonId, o.keepOutId])}>
                      {`${content.elements.find((e) => e.id === o.balloonId)?.name ?? o.balloonId} → ${
                        content.elements.find((e) => e.id === o.keepOutId)?.name ?? o.keepOutId
                      }（${Math.round(o.share * 100)}%）`}
                    </button>
                  </li>
                ))}
              </ul>
              <button disabled={readOnly} onClick={moveBalloons}>
                吹き出しをよける
              </button>
            </div>
          )}
          {!!stuck && (
            <p role="status">{`${stuck} 個の吹き出しはコマの中に空きがなく、動かせませんでした`}</p>
          )}
          {!!locked && (
            <p role="status">{`${locked} 個の吹き出しはロックか非表示のため、動かせませんでした`}</p>
          )}
          {noRoom && (
            <p role="status">
              このコマには顔や人物、ほかの吹き出しに重ならない空きがないため、吹き出しを入れませんでした
            </p>
          )}
          <p>
            Native text and paths. Vertical writing (縦書き) is set per text box in the inspector;
            ruby is written as ｜漢字《かんじ》. Balloon paths require vector capture.
          </p>
        </>
      )}
    </section>
  );
}
