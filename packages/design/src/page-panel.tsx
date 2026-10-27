import { insertDesignPagePath, insertDesignSpeechBalloon } from './page-artwork';
import { newId } from '@editor-platform/artifact-core';
import { transaction, type EditorCommand } from '@editor-platform/editor-core';
import { insertElement, updateElement, type DesignContent } from './model';
import { insertDesignPage, insertDesignPanel, setDesignPagination } from './pagination';

/** Generic native page controls, shared by ordinary and independent Design Surfaces. */
export function DesignPagePanel({
  content,
  apply,
  choose,
  readOnly,
}: {
  content: DesignContent;
  apply: (cmd: EditorCommand<DesignContent>) => boolean;
  choose: (ids: string[]) => void;
  readOnly: boolean;
}) {
  const pagination = content.pagination;
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
    const id = newId('dialogue');
    const insert = insertElement('text', {
      id,
      parentId: panelId,
      bounds: { x: panel.bounds.x + 30, y: panel.bounds.y + 30, width: 400, height: 70 },
    });
    if (
      apply(
        transaction('Insert dialogue', [
          insert,
          updateElement(id, { text: 'Dialogue', fill: '#111111' }),
        ]),
      )
    )
      choose([id]);
  }
  function artwork(panelId: string, kind: 'line' | 'cubic' | 'balloon') {
    const panel = content.elements.find((e) => e.id === panelId)!;
    const bounds = {
      x: panel.bounds.x + panel.bounds.width * 0.1,
      y: panel.bounds.y + panel.bounds.height * 0.1,
      width: panel.bounds.width * 0.7,
      height: panel.bounds.height * 0.65,
    };
    const cmd =
      kind === 'balloon'
        ? insertDesignSpeechBalloon(panelId, bounds, 'Dialogue')
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
                  disabled={readOnly}
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
                        disabled={readOnly}
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
          <p>
            Horizontal text and native paths. Balloon paths require vector capture; vertical text
            and ruby are unsupported.
          </p>
        </>
      )}
    </section>
  );
}
