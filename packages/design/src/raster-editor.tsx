import { useContext, useEffect, useRef, useState } from 'react';
import { Dialog, EditorInputsContext, EditorHistoryContext } from '@editor-platform/editor-ui';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { DesignContent, DesignElement } from './model';
import {
  designPngInfo,
  editableDesignRaster,
  replaceDesignRaster,
  designRasterLimits,
  type RasterRegion,
} from './raster';
import { decodeDesignPng } from './raster-canvas';
import './raster-editor.css';

export interface DesignRasterSelection {
  elementId: string;
  src: string;
  region: RasterRegion;
}
interface Props {
  enabled: boolean;
  content: DesignContent;
  element?: DesignElement;
  readOnly: boolean;
  apply(c: EditorCommand<DesignContent>): boolean;
  onSelection?(s: DesignRasterSelection): void;
}
export function DesignRasterControls(props: Props) {
  const [open, setOpen] = useState<string>();
  let eligible = false,
    reason = '';
  if (props.enabled && props.element?.type === 'image')
    try {
      editableDesignRaster(props.content, props.element.id);
      eligible = true;
    } catch (e) {
      reason = (e as Error).message;
    }
  return (
    <>
      {props.enabled && props.element?.type === 'image' && (
        <div className="design-raster-entry">
          <button disabled={props.readOnly || !eligible} onClick={() => setOpen(props.element!.id)}>
            画像を直接描き直す
          </button>
          {reason && <p>{reason}</p>}
        </div>
      )}
      {open && (
        <RasterEditor key={open} {...props} elementId={open} close={() => setOpen(undefined)} />
      )}
    </>
  );
}
function RasterEditor({
  content,
  elementId,
  readOnly,
  apply,
  onSelection,
  close,
}: Props & { elementId: string; close(): void }) {
  const inputs = useContext(EditorInputsContext),
    history = useContext(EditorHistoryContext),
    canvas = useRef<HTMLCanvasElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const latest = useRef({ content, readOnly, apply });
  latest.current = { content, readOnly, apply };
  const [tool, setTool] = useState<'paint' | 'erase' | 'select'>('paint'),
    [width, setWidth] = useState(4),
    [color, setColor] = useState('#151515'),
    [zoom, setZoom] = useState('fit');
  const [region, setRegion] = useState<RasterRegion>(),
    [draftRegion, setDraftRegion] = useState<RasterRegion>(),
    [ready, setReady] = useState(false),
    [error, setError] = useState('');
  const [area, setArea] = useState({ width: 800, height: 600 }),
    [info, setInfo] = useState({ width: 1, height: 1 });
  const target = content.elements.find((e) => e.id === elementId),
    src = target?.src;
  const gesture = useRef<
    | {
        pointerId: number;
        base: DesignContent;
        tool: typeof tool;
        last: { x: number; y: number };
        first: { x: number; y: number };
        samples: number;
      }
    | undefined
  >(undefined);
  const loadToken = useRef(0);
  async function restore() {
    const token = ++loadToken.current;
    setReady(false);
    try {
      const current = latest.current.content;
      const e = editableDesignRaster(current, elementId),
        png = await decodeDesignPng(e.src!);
      if (token !== loadToken.current) return;
      const surface = canvas.current;
      if (!surface) return;
      surface.width = png.width;
      surface.height = png.height;
      const ctx = surface.getContext('2d')!;
      ctx.clearRect(0, 0, png.width, png.height);
      ctx.drawImage(png.image, 0, 0);
      setInfo({ width: png.width, height: png.height });
      setReady(true);
    } catch (e) {
      if (token === loadToken.current) setError((e as Error).message);
    }
  }
  function cancel() {
    const g = gesture.current;
    gesture.current = undefined;
    setDraftRegion(undefined);
    inputs?.changed();
    if (g && g.tool !== 'select') void restore();
  }
  useEffect(() => {
    cancel();
    setError('');
    void restore();
    return () => {
      loadToken.current++;
    };
  }, [src]);
  useEffect(() => {
    if (readOnly) cancel();
  }, [readOnly]);
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const update = () => setArea({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(
    () =>
      inputs?.register({
        label: 'Raster gesture',
        read: () => ({ dirty: !!gesture.current }),
        prepare: () => {
          throw Error('画像の描画を確定またはキャンセルしてください。');
        },
        focus: () => canvas.current?.focus(),
        history: () => {
          if (!gesture.current) return false;
          cancel();
          return true;
        },
      }),
    [inputs],
  );
  useEffect(
    () => () => {
      gesture.current = undefined;
      loadToken.current++;
      inputs?.changed();
    },
    [inputs],
  );
  const scale =
    zoom === 'fit'
      ? Math.min(area.width / info.width, area.height / info.height, 1)
      : Number(zoom) / 100;
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const boundary = (gesture.current?.tool ?? tool) === 'select' ? 0 : 1;
    return {
      x: Math.max(
        0,
        Math.min(info.width - boundary, ((event.clientX - box.x) * info.width) / box.width),
      ),
      y: Math.max(
        0,
        Math.min(info.height - boundary, ((event.clientY - box.y) * info.height) / box.height),
      ),
    };
  }
  function rectangle(a: { x: number; y: number }, b: { x: number; y: number }): RasterRegion {
    const x = Math.min(info.width - 1, Math.floor(Math.min(a.x, b.x))),
      y = Math.min(info.height - 1, Math.floor(Math.min(a.y, b.y)));
    return {
      x,
      y,
      width: Math.min(info.width, Math.max(x + 1, Math.ceil(Math.max(a.x, b.x)))) - x,
      height: Math.min(info.height, Math.max(y + 1, Math.ceil(Math.max(a.y, b.y)))) - y,
    };
  }
  function paint(
    a: { x: number; y: number },
    b: { x: number; y: number },
    mode: 'paint' | 'erase',
  ) {
    const ctx = canvas.current!.getContext('2d')!;
    ctx.save();
    ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (a.x === b.x && a.y === b.y) {
      ctx.beginPath();
      ctx.arc(a.x, a.y, width / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  const selected = draftRegion ?? region;
  return (
    <Dialog
      title="画像レイヤーを直接編集"
      onClose={() => {
        cancel();
        close();
      }}
    >
      <p>{target?.name} — 描いたピクセルは同じ画像レイヤーに確定します。</p>
      <div className="design-raster-toolbar">
        {(['paint', 'erase', 'select'] as const).map((t, i) => (
          <button
            key={t}
            aria-pressed={tool === t}
            disabled={readOnly || !ready}
            onClick={() => setTool(t)}
          >
            {['ブラシ', '消しゴム', '範囲選択'][i]}
          </button>
        ))}
        <label>
          色
          <input
            aria-label="描画色"
            type="color"
            value={color}
            disabled={readOnly}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <label>
          幅
          <input
            aria-label="ブラシ幅"
            type="range"
            min={1}
            max={64}
            value={width}
            disabled={readOnly}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
          <span>{width}px</span>
        </label>
        <label>
          表示
          <select
            aria-label="画像表示倍率"
            value={zoom}
            onChange={(e) => {
              if (gesture.current) return;
              setZoom(e.target.value);
            }}
          >
            <option value="fit">全体</option>
            <option value="50">50%</option>
            <option value="100">100%</option>
            <option value="200">200%</option>
          </select>
        </label>
        {history && (
          <>
            <button onClick={() => history.undo()}>画像編集を元に戻す</button>
            <button onClick={() => history.redo()}>画像編集をやり直す</button>
          </>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!ready && <p role="status">画像を読み込み中です。</p>}
      <div ref={scroll} className="design-raster-scroll">
        <div
          className="design-raster-stage"
          style={{ width: info.width * scale, height: info.height * scale }}
        >
          <canvas
            ref={canvas}
            role="application"
            aria-label="画像ピクセル編集"
            tabIndex={0}
            style={{ width: '100%', height: '100%', touchAction: 'none', cursor: 'crosshair' }}
            onPointerDown={(e) => {
              if (
                !ready ||
                latest.current.readOnly ||
                gesture.current ||
                e.button !== 0 ||
                !e.isPrimary
              )
                return;
              e.preventDefault();
              e.stopPropagation();
              try {
                inputs?.flush();
                editableDesignRaster(latest.current.content, elementId);
                const p = point(e);
                e.currentTarget.focus({ preventScroll: true });
                e.currentTarget.setPointerCapture(e.pointerId);
                gesture.current = {
                  pointerId: e.pointerId,
                  base: latest.current.content,
                  tool,
                  last: p,
                  first: p,
                  samples: 1,
                };
                inputs?.changed();
                if (tool === 'select') setDraftRegion(rectangle(p, p));
                else paint(p, p, tool);
              } catch (ex) {
                setError((ex as Error).message);
              }
            }}
            onPointerMove={(e) => {
              const g = gesture.current;
              if (!g || g.pointerId !== e.pointerId) return;
              e.preventDefault();
              e.stopPropagation();
              if (++g.samples > designRasterLimits.samples) {
                cancel();
                setError('描線は短く区切ってください。');
                return;
              }
              const p = point(e);
              if (g.tool === 'select') setDraftRegion(rectangle(g.first, p));
              else paint(g.last, p, g.tool);
              g.last = p;
            }}
            onPointerUp={(e) => {
              const g = gesture.current;
              if (!g || g.pointerId !== e.pointerId) return;
              e.preventDefault();
              e.stopPropagation();
              const p = point(e);
              gesture.current = undefined;
              inputs?.changed();
              setDraftRegion(undefined);
              if (g.tool === 'select') {
                setRegion(rectangle(g.first, p));
                return;
              }
              try {
                paint(g.last, p, g.tool);
                const next = e.currentTarget.toDataURL('image/png');
                designPngInfo(next);
                const c = replaceDesignRaster(
                  g.base,
                  elementId,
                  next,
                  g.tool,
                  () => !latest.current.readOnly,
                );
                if (!latest.current.apply(c)) {
                  void restore();
                  setError('画像修正を適用できませんでした。');
                  return;
                }
                setError('');
              } catch (ex) {
                setError((ex as Error).message);
                void restore();
              }
            }}
            onPointerCancel={cancel}
            onLostPointerCapture={() => {
              if (gesture.current) cancel();
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Escape' && gesture.current) {
                e.preventDefault();
                e.stopPropagation();
                cancel();
              } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                e.stopPropagation();
                if (gesture.current) cancel();
                else if (!latest.current.readOnly) {
                  if (e.shiftKey) history?.redo();
                  else history?.undo();
                }
              }
            }}
          />
          {selected && (
            <svg className="design-raster-selection" viewBox={`0 0 ${info.width} ${info.height}`}>
              <rect
                x={selected.x}
                y={selected.y}
                width={selected.width}
                height={selected.height}
                fill="#6366f122"
                stroke="#4f46e5"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
        </div>
      </div>
      <p className="design-raster-region-status" aria-live="polite">
        {selected
          ? `範囲：${selected.x}, ${selected.y} / ${selected.width} × ${selected.height} px`
          : '範囲選択で、AIに任せる箇所を指定できます。'}
      </p>
      <footer>
        <button
          onClick={() => {
            cancel();
            close();
          }}
        >
          編集を閉じる
        </button>
        {onSelection && (
          <button
            disabled={!region || !ready || readOnly}
            onClick={() => {
              if (gesture.current) return;
              try {
                const e = editableDesignRaster(latest.current.content, elementId);
                onSelection({ elementId, src: e.src!, region: region! });
                close();
              } catch (ex) {
                setError((ex as Error).message);
              }
            }}
          >
            選択範囲を使う
          </button>
        )}
      </footer>
    </Dialog>
  );
}
