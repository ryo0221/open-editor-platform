// The Mind Map Surface. It edits only through Mind Map commands passed to `execute`; the Host
// owns history, saving, permissions and proposals.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import type { EditorCommand } from '@editor-platform/editor-core';
import { useEditorInput } from '@editor-platform/editor-ui';
import {
  MINDMAP_LIMITS,
  MINDMAP_MARK_NAMES,
  MINDMAP_MARKS,
  MINDMAP_PALETTE,
  addMindmapNode,
  deleteMindmapNode,
  editMindmapNodeFields,
  exportMindmapJson,
  exportMindmapMarkdown,
  exportMindmapSvg,
  layoutMindmap,
  mindmapEdgePath,
  mindmapParent,
  mindmapSubtree,
  moveMindmapNode,
  newMindmapNodeId,
  reorderMindmapNode,
  setMindmapLayout,
  type MindmapContent,
  type MindmapLayout,
  type MindmapMark,
} from '@editor-platform/mindmap-core';
import './styles.css';

export interface MindmapSurfaceProps {
  content: MindmapContent;
  readOnly?: boolean;
  /** Runs a command through the Host; false when the Host refused it. */
  execute(command: EditorCommand<MindmapContent>): boolean;
  /** Tells the Host which node is selected. */
  select?(ids: string[]): void;
  /** The file name (without extension) used for exports. */
  fileName?: string;
}

const LAYOUTS: readonly (readonly [MindmapLayout, string])[] = [
  ['radial', '左右'],
  ['right', '右向き'],
  ['tree', '下向き'],
];

interface Draft {
  text: string;
  color: string;
  marks: MindmapMark[];
  note: string;
}
const draftOf = (content: MindmapContent, id: string): Draft => {
  const n = content.nodes[id];
  return { text: n.text, color: n.color ?? '', marks: [...(n.marks ?? [])], note: n.note ?? '' };
};
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function svgToPng(svg: string): Promise<Blob> {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('図を描けませんでした。'));
      image.src = url;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth * scale;
    canvas.height = image.naturalHeight * scale;
    if (canvas.width > 16384 || canvas.height > 16384)
      throw new Error('地図が大きすぎて PNG にできません。SVG で書き出してください。');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PNG を作れませんでした。');
    context.scale(scale, scale);
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('PNG を作れませんでした。'))),
        'image/png',
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function MindmapSurface({
  content,
  readOnly = false,
  execute,
  select,
  fileName = 'mindmap',
}: MindmapSurfaceProps) {
  const [selected, setSelected] = useState(content.rootId);
  const [folded, setFolded] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(false);
  const [status, setStatus] = useState('');
  // The node the form's draft belongs to, and that node's fields when the draft started.
  const [draftFor, setDraftFor] = useState(content.rootId);
  const [base, setBase] = useState<Draft>(() => draftOf(content, content.rootId));
  const [draft, setDraft] = useState<Draft>(base);
  const [moveTarget, setMoveTarget] = useState('');
  const [moveIndex, setMoveIndex] = useState(0);
  const [moveSide, setMoveSide] = useState<'left' | 'right'>('right');
  const composing = useRef(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusAfter = useRef<string | undefined>(undefined);
  // Ids once used in this map are never issued again, so Undo of an add never meets a reused id.
  const issued = useRef(new Set<string>());
  for (const id of Object.keys(content.nodes)) issued.current.add(id);

  const current = content.nodes[selected] ? selected : content.rootId;
  const node = content.nodes[current];
  const dirty = !sameDraft(draft, base);
  const placement = useMemo(() => layoutMindmap(content, folded), [content, folded]);
  const visible = placement.boxes;

  // The selected node changed outside (proposal, Undo): an untouched draft follows it. A dirty
  // draft keeps its node and base, so Apply and the Host boundary report the conflict instead of
  // writing stale fields onto another node.
  useEffect(() => {
    if (dirty) return;
    const next = draftOf(content, current);
    if (draftFor !== current || !sameDraft(next, base)) {
      // The selected node went away (Undo of its add): the Host follows the fallback selection.
      if (current !== selected) {
        setSelected(current);
        select?.([current]);
      }
      setDraftFor(current);
      setBase(next);
      setDraft(next);
    }
  }, [content, current, dirty]);

  /** Why the draft can no longer be applied, or undefined. */
  const conflict = () =>
    draftFor !== current || !content.nodes[current] || !sameDraft(draftOf(content, current), base)
      ? '編集中にこの枝が変更または削除されました。入力を保持しています。'
      : undefined;

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  useEffect(() => {
    if (!focusAfter.current) return;
    const id = focusAfter.current;
    focusAfter.current = undefined;
    if (id === 'name') nameRef.current?.focus();
    else mapRef.current?.querySelector<HTMLButtonElement>(`[data-node-id="${id}"]`)?.focus();
  });

  const shown = fit
    ? Math.min(
        1,
        ((mapRef.current?.clientWidth ?? placement.width) - 4) / placement.width,
        Math.max(240, window.innerHeight * 0.7) / placement.height,
      )
    : zoom;

  function run(command: EditorCommand<MindmapContent>): boolean {
    try {
      command.apply(content);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : '操作できません。');
      return false;
    }
    if (!execute(command)) {
      setStatus('この地図は変更できません。');
      return false;
    }
    setStatus('');
    return true;
  }

  function choose(id: string, focus = false) {
    if (id === current) return;
    if (dirty) {
      setStatus('未確定の入力を適用または取り消してください。');
      return;
    }
    const next = draftOf(content, id);
    setSelected(id);
    setDraftFor(id);
    setBase(next);
    setDraft(next);
    setStatus('');
    select?.([id]);
    if (focus) focusAfter.current = id;
  }

  function add(child: boolean) {
    if (readOnly) return;
    if (dirty) {
      setStatus('未確定の入力を適用または取り消してください。');
      return;
    }
    const parent = child ? node : mindmapParent(content, current);
    if (!parent) {
      setStatus('中心には兄弟を足せません。');
      return;
    }
    let id = '';
    for (let i = 0; i < 32 && !id; i++) {
      const candidate = newMindmapNodeId();
      if (!issued.current.has(candidate)) id = candidate;
    }
    if (!id) {
      setStatus('新しい枝のIDを発行できませんでした。');
      return;
    }
    issued.current.add(id);
    const index = child ? parent.children.length : parent.children.indexOf(current) + 1;
    if (run(addMindmapNode(parent.id, index, id, ''))) {
      setFolded((f) => new Map(f).set(parent.id, false));
      const fresh = { text: '', color: '', marks: [], note: '' };
      setSelected(id);
      setDraftFor(id);
      setBase(fresh);
      setDraft(fresh);
      select?.([id]);
      focusAfter.current = 'name';
    }
  }

  function remove() {
    if (readOnly || current === content.rootId) return;
    if (dirty) {
      setStatus('未確定の入力を適用または取り消してください。');
      return;
    }
    const parent = mindmapParent(content, current);
    const count = mindmapSubtree(content, current).length;
    if (run(deleteMindmapNode(current)) && parent) {
      const next = draftOf(content, parent.id);
      setSelected(parent.id);
      setDraftFor(parent.id);
      setBase(next);
      setDraft(next);
      select?.([parent.id]);
      setStatus(count > 1 ? `子孫を含む ${count} 個の枝を消しました（Undo で戻せます）。` : '');
    }
  }

  function toggle(id: string) {
    const n = content.nodes[id];
    if (!n?.children.length) return;
    setFolded((f) => new Map(f).set(id, !(f.get(id) ?? n.collapsed ?? false)));
  }

  function applyDraft() {
    if (readOnly || composing.current) return;
    const problem = conflict();
    if (problem) {
      setStatus(problem);
      return;
    }
    const latest = content.nodes[current];
    if (!dirty) {
      setStatus('変更がありません。');
      return;
    }
    if (run(editMindmapNodeFields(current, latest, draft))) setBase(draft);
  }

  // Save, History and switching artifacts first commit the unapplied fields as one command, or
  // refuse with the reason (the Host's input boundary).
  useEditorInput({
    label: '枝の情報',
    read: () => ({ dirty: dirty && !readOnly, composing: composing.current }),
    prepare: () => {
      const problem = conflict();
      if (problem) throw new Error(problem);
      const latest = content.nodes[current];
      const command = editMindmapNodeFields(current, latest, draft);
      command.apply(content);
      return () => {
        if (!execute(command)) return false;
        setBase(draft);
        setStatus('');
      };
    },
    focus: () => nameRef.current?.focus(),
  });

  function onNodeKey(event: KeyboardEvent<HTMLButtonElement>, index: number, id: string) {
    if (event.nativeEvent.isComposing || composing.current) return;
    if (event.key === 'Tab' && !event.shiftKey && !readOnly) {
      event.preventDefault();
      add(true);
    } else if (event.key === 'Enter' && !readOnly) {
      event.preventDefault();
      add(false);
    } else if (event.key === 'F2') {
      event.preventDefault();
      nameRef.current?.focus();
    } else if (event.key === 'Delete' && !readOnly) {
      event.preventDefault();
      remove();
    } else if (event.key === ' ') {
      event.preventDefault();
      toggle(id);
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
      const next = visible[Math.max(0, Math.min(visible.length - 1, index + step))];
      choose(next.id, true);
    }
  }

  async function exportAs(kind: 'svg' | 'png' | 'md' | 'json') {
    try {
      if (kind === 'svg')
        download(`${fileName}.svg`, exportMindmapSvg(content, { folded }), 'image/svg+xml');
      else if (kind === 'png')
        download(
          `${fileName}.png`,
          await svgToPng(exportMindmapSvg(content, { folded })),
          'image/png',
        );
      else if (kind === 'md')
        download(`${fileName}.md`, exportMindmapMarkdown(content), 'text/markdown');
      else download(`${fileName}.mindmap.json`, exportMindmapJson(content), 'application/json');
      setStatus('');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : '書き出せませんでした。');
    }
  }

  const parent = mindmapParent(content, current);
  const siblingIndex = parent ? parent.children.indexOf(current) : -1;
  const inside = new Set(mindmapSubtree(content, current));
  const targets = Object.values(content.nodes).filter((n) => !inside.has(n.id));
  const target = targets.some((n) => n.id === moveTarget) ? moveTarget : (targets[0]?.id ?? '');
  const byId = new Map(visible.map((b) => [b.id, b]));
  const editable = !readOnly && !!node;

  return (
    <section className="mindmap-editor" aria-label="マインドマップ">
      <div className="mindmap-toolbar" role="toolbar" aria-label="マインドマップの操作">
        <button
          type="button"
          onClick={() => add(false)}
          disabled={readOnly || current === content.rootId}
        >
          枝を足す
        </button>
        <button type="button" onClick={() => add(true)} disabled={readOnly}>
          子を足す
        </button>
        <button type="button" onClick={remove} disabled={readOnly || current === content.rootId}>
          消す
        </button>
        <select
          aria-label="配置"
          value={content.layout}
          disabled={readOnly}
          onChange={(e) => run(setMindmapLayout(e.target.value as MindmapLayout))}
        >
          {LAYOUTS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="mindmap-toolbar-group">
          <button
            type="button"
            disabled={shown <= 0.25}
            onClick={() => {
              setFit(false);
              setZoom(Math.max(0.25, Math.round((shown - 0.25) * 4) / 4));
            }}
          >
            縮める
          </button>
          <button
            type="button"
            disabled={shown >= 1.5}
            onClick={() => {
              setFit(false);
              setZoom(Math.min(1.5, Math.round((shown + 0.25) * 4) / 4));
            }}
          >
            広げる
          </button>
          <button type="button" onClick={() => setFit(true)}>
            全体を見る
          </button>
          <span className="mindmap-zoom" aria-label="表示の倍率">
            {Math.round(shown * 100)}%
          </span>
        </span>
        <span className="mindmap-toolbar-group" aria-label="書き出し">
          <button type="button" onClick={() => void exportAs('svg')}>
            SVG
          </button>
          <button type="button" onClick={() => void exportAs('png')}>
            PNG
          </button>
          <button type="button" onClick={() => void exportAs('md')}>
            Markdown
          </button>
          <button type="button" onClick={() => void exportAs('json')}>
            JSON
          </button>
        </span>
      </div>
      <p className="mindmap-status" role="status">
        {status}
      </p>
      <div className="mindmap-main">
        <div className="mindmap-map" ref={mapRef}>
          <div
            className="mindmap-sizer"
            style={{ width: placement.width * shown, height: placement.height * shown }}
          >
            <div
              className="mindmap-canvas"
              style={{
                width: placement.width,
                height: placement.height,
                transform: shown === 1 ? undefined : `scale(${shown})`,
              }}
            >
              <svg
                className="mindmap-lines"
                width={placement.width}
                height={placement.height}
                aria-hidden="true"
              >
                {visible.map((box) =>
                  box.parentId ? (
                    <path
                      key={box.id}
                      d={mindmapEdgePath(byId.get(box.parentId)!, box, content.layout === 'tree')}
                    />
                  ) : null,
                )}
              </svg>
              {visible.map((box, index) => {
                const n = content.nodes[box.id];
                const marks = n.marks ?? [];
                return (
                  <button
                    type="button"
                    key={box.id}
                    data-node-id={box.id}
                    className={`mindmap-node${box.id === content.rootId ? ' mindmap-root' : ''}`}
                    aria-pressed={box.id === current}
                    title={
                      marks.length
                        ? `印: ${marks.map((m) => MINDMAP_MARK_NAMES[m]).join('、')}`
                        : undefined
                    }
                    style={{
                      left: box.x,
                      top: box.y,
                      width: box.width,
                      minHeight: box.height,
                      ...(n.color ? { borderColor: n.color } : {}),
                    }}
                    onClick={() => choose(box.id)}
                    onDoubleClick={() => toggle(box.id)}
                    onKeyDown={(e) => onNodeKey(e, index, box.id)}
                  >
                    <span className="mindmap-node-text">{n.text || '（無題）'}</span>
                    {marks.length ? (
                      <span className="mindmap-badges" aria-hidden="true">
                        {marks.map((m) => (
                          <span key={m} className={`mindmap-badge mindmap-badge-${m}`}>
                            {MINDMAP_MARK_NAMES[m]}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    {box.folded ? (
                      <span className="mindmap-fold-count">
                        +{mindmapSubtree(content, box.id).length - 1}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <form
          className="mindmap-panel"
          aria-label="枝の情報"
          onSubmit={(e) => {
            e.preventDefault();
            applyDraft();
          }}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
        >
          <h2>枝の情報</h2>
          <label>
            名前
            <input
              ref={nameRef}
              aria-label="名前"
              value={draft.text}
              maxLength={MINDMAP_LIMITS.text}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, text: e.target.value.replace(/[\r\n]/g, ' ') })}
            />
          </label>
          <fieldset
            className="mindmap-palette"
            role="radiogroup"
            aria-label="色"
            disabled={!editable}
          >
            <legend>色</legend>
            {MINDMAP_PALETTE.map(([label, value]) => (
              <button
                type="button"
                key={label}
                role="radio"
                aria-label={label}
                title={label}
                aria-checked={draft.color === value}
                className={`mindmap-swatch${value ? '' : ' mindmap-swatch-none'}`}
                style={value ? ({ '--swatch': value } as CSSProperties) : undefined}
                onClick={() => setDraft({ ...draft, color: value })}
              />
            ))}
            {draft.color && !MINDMAP_PALETTE.some(([, v]) => v === draft.color) ? (
              <button
                type="button"
                role="radio"
                aria-label="いまの色"
                aria-checked
                className="mindmap-swatch"
                style={{ '--swatch': draft.color } as CSSProperties}
              />
            ) : null}
          </fieldset>
          <fieldset className="mindmap-marks" disabled={!editable}>
            <legend>印（{MINDMAP_LIMITS.marks} つまで）</legend>
            {MINDMAP_MARKS.map((m) => {
              const checked = draft.marks.includes(m);
              return (
                <label key={m}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && draft.marks.length >= MINDMAP_LIMITS.marks}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        marks: checked
                          ? draft.marks.filter((x) => x !== m)
                          : MINDMAP_MARKS.filter((x) => x === m || draft.marks.includes(x)),
                      })
                    }
                  />
                  {MINDMAP_MARK_NAMES[m]}
                </label>
              );
            })}
          </fieldset>
          <label>
            メモ
            <textarea
              aria-label="メモ"
              value={draft.note}
              maxLength={MINDMAP_LIMITS.note * 2}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </label>
          <div className="mindmap-actions">
            <button type="submit" disabled={!editable || !dirty}>
              適用
            </button>
            <button
              type="button"
              disabled={!editable || !dirty}
              onClick={() => {
                setDraft(base);
                setStatus('');
              }}
            >
              取消
            </button>
          </div>
          {parent ? (
            <div className="mindmap-branch-actions">
              <h3>枝の移動</h3>
              <div className="mindmap-actions">
                <button
                  type="button"
                  disabled={readOnly || siblingIndex === 0}
                  onClick={() => run(reorderMindmapNode(current, siblingIndex - 1))}
                >
                  前へ
                </button>
                <button
                  type="button"
                  disabled={readOnly || siblingIndex === parent.children.length - 1}
                  onClick={() => run(reorderMindmapNode(current, siblingIndex + 1))}
                >
                  後ろへ
                </button>
              </div>
              <label>
                移動先の親
                <select
                  aria-label="移動先の親"
                  value={target}
                  disabled={readOnly}
                  onChange={(e) => setMoveTarget(e.target.value)}
                >
                  {targets.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.text || '（無題）'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                挿入位置
                <input
                  type="number"
                  aria-label="挿入位置"
                  min={0}
                  value={moveIndex}
                  disabled={readOnly}
                  onChange={(e) => setMoveIndex(Number(e.target.value))}
                />
              </label>
              {target === content.rootId ? (
                <label>
                  中心からの方向
                  <select
                    aria-label="中心からの方向"
                    value={moveSide}
                    disabled={readOnly}
                    onChange={(e) => setMoveSide(e.target.value as 'left' | 'right')}
                  >
                    <option value="right">右</option>
                    <option value="left">左</option>
                  </select>
                </label>
              ) : null}
              <button
                type="button"
                disabled={readOnly || !target}
                onClick={() =>
                  run(
                    moveMindmapNode(
                      current,
                      target,
                      moveIndex,
                      target === content.rootId ? moveSide : undefined,
                    ),
                  )
                }
              >
                移す
              </button>
            </div>
          ) : null}
        </form>
      </div>
    </section>
  );
}
