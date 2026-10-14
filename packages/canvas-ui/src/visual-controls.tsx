import { useContext, useRef, useState, type ReactNode } from 'react';
import { CanvasTextContext } from './text-editor';
import { canvasTextReplacement } from './text-engine';
import {
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Shapes,
  Type,
  ImagePlus,
  Copy,
  Clipboard,
  Scissors,
  Trash2,
  Group,
  Ungroup,
  ArrowUpToLine,
  ArrowDownToLine,
  ArrowUp,
  ArrowDown,
  FlipHorizontal2,
  FlipVertical2,
  RotateCw,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Download,
  Square,
} from 'lucide-react';
import { IconButton, Menu, Section, CommitInput } from '@editor-platform/editor-ui';
import {
  shapeNames,
  shapePrimitives,
  serializeSvg,
  drawingSvg,
  type Alignment,
  type Bounds,
  type Drawing,
  type ShapeKind,
  type VisualStyle,
} from '@editor-platform/editor-core';
export function ShapePicker({ onPick }: { onPick: (shape: ShapeKind) => void }) {
  const [search, setSearch] = useState(''),
    [category, setCategory] = useState('All'),
    [recent, setRecent] = useState<ShapeKind[]>(() => {
      try {
        return JSON.parse(localStorage.getItem('ep-recent-shapes') ?? '[]');
      } catch {
        return [];
      }
    });
  const categoryFor = (s: ShapeKind) =>
    s.startsWith('arrow-') || s === 'chevron'
      ? 'Arrows'
      : ['line', 'arrow', 'double-arrow', 'elbow', 'curve'].includes(s)
        ? 'Lines'
        : ['callout', 'cloud'].includes(s)
          ? 'Callouts'
          : 'Basic';
  return (
    <div className="shape-picker">
      <input
        aria-label="Search shapes"
        placeholder="Search shapes"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <select
        aria-label="Shape category"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        {['All', 'Recent', 'Basic', 'Arrows', 'Lines', 'Callouts'].map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <div className="shape-grid">
        {(category === 'Recent' ? recent : shapeNames)
          .filter(
            (s) =>
              s.includes(search.toLowerCase()) &&
              (category === 'All' || category === 'Recent' || categoryFor(s) === category),
          )
          .map((s) => (
            <button
              key={s}
              aria-label={`Insert ${s}`}
              title={s}
              onClick={() => {
                onPick(s);
                const next = [s, ...recent.filter((x) => x !== s)].slice(0, 8);
                setRecent(next);
                try {
                  localStorage.setItem('ep-recent-shapes', JSON.stringify(next));
                } catch {
                  /* preference only */
                }
              }}
            >
              <img
                alt=""
                src={
                  'data:image/svg+xml,' +
                  encodeURIComponent(
                    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 66 50">${serializeSvg(shapePrimitives(s, { x: 0, y: 0, width: 60, height: 44 }, { stroke: '#384963', strokeWidth: 1.5 }, '#dde7f5'))}</svg>`,
                  )
                }
              />
              <span>{s}</span>
            </button>
          ))}
      </div>
    </div>
  );
}
export function InsertTools({
  onShape,
  onText,
  onImage,
  children,
  readOnly = false,
}: {
  onShape: (s: ShapeKind) => void;
  onText: () => void;
  onImage: (file: File) => void;
  children?: React.ReactNode;
  readOnly?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Menu label="Insert shapes" icon={Shapes}>
        <ShapePicker onPick={onShape} />
      </Menu>
      <IconButton
        icon={Type}
        label="Insert text"
        shortcut="T"
        onClick={onText}
        disabled={readOnly}
      />
      <IconButton
        icon={ImagePlus}
        label="Insert image"
        onClick={() => input.current?.click()}
        disabled={readOnly}
      />
      <input
        ref={input}
        hidden
        type="file"
        aria-label="Insert image file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImage(f);
          e.target.value = '';
        }}
      />
      {children}
    </>
  );
}
const alignmentIcons = {
  left: AlignStartVertical,
  center: AlignCenterVertical,
  right: AlignEndVertical,
  top: AlignStartHorizontal,
  middle: AlignCenterHorizontal,
  bottom: AlignEndHorizontal,
};
export function ArrangeMenu({
  count,
  onAction,
  onAlign,
  reference,
  onReference,
  readOnly = false,
}: {
  count: number;
  onAction: (action: string, value?: number) => void;
  onAlign: (mode: Alignment) => void;
  reference?: string;
  onReference?: (s: string) => void;
  readOnly?: boolean;
}) {
  return (
    <Menu label="Arrange" icon={AlignStartVertical}>
      <div className="ep-fields">
        {(Object.keys(alignmentIcons) as Alignment[]).map((a) => (
          <IconButton
            key={a}
            icon={alignmentIcons[a]}
            label={`Align ${a}`}
            disabled={!count || readOnly}
            reason="Select one or more elements"
            onClick={() => onAlign(a)}
          />
        ))}
      </div>
      {onReference && (
        <label className="ep-field">
          Align relative to
          <select
            aria-label="Alignment reference"
            value={reference}
            onChange={(e) => onReference(e.target.value)}
          >
            <option value="selection">Selection bounds</option>
            <option value="page">Page / parent frame</option>
          </select>
        </label>
      )}
      <div className="ep-fields">
        <IconButton
          icon={AlignHorizontalDistributeCenter}
          label="Distribute horizontally"
          disabled={count < 3 || readOnly}
          reason="Select at least three elements"
          onClick={() => onAction('distribute-x')}
        />
        <IconButton
          icon={AlignVerticalDistributeCenter}
          label="Distribute vertically"
          disabled={count < 3 || readOnly}
          reason="Select at least three elements"
          onClick={() => onAction('distribute-y')}
        />
      </div>
      <CommitInput
        label="Horizontal gap (px)"
        value={16}
        type="number"
        onCommit={(v) => onAction('gap-x', Number(v))}
      />
      <CommitInput
        label="Vertical gap (px)"
        value={16}
        type="number"
        onCommit={(v) => onAction('gap-y', Number(v))}
      />
      {['width', 'height', 'both'].map((s) => (
        <button key={s} disabled={count < 2 || readOnly} onClick={() => onAction(`same-${s}`)}>
          Match {s} to first selected
        </button>
      ))}
      <hr />
      {(
        [
          [Group, 'group', 'Group'],
          [Ungroup, 'ungroup', 'Ungroup'],
          [ArrowUpToLine, 'front', 'Bring to front'],
          [ArrowUp, 'forward', 'Bring forward'],
          [ArrowDown, 'backward', 'Send backward'],
          [ArrowDownToLine, 'back', 'Send to back'],
          [FlipHorizontal2, 'flip-x', 'Flip horizontally'],
          [FlipVertical2, 'flip-y', 'Flip vertically'],
          [RotateCw, 'rotate', 'Rotate 90°'],
          [Lock, 'lock', 'Lock'],
          [Unlock, 'unlock', 'Unlock'],
          [EyeOff, 'hide', 'Hide'],
          [Eye, 'show', 'Show'],
        ] as const
      ).map(([Icon, action, label]) => (
        <button key={action} disabled={!count || readOnly} onClick={() => onAction(action)}>
          <Icon size={17} />
          {label}
        </button>
      ))}
    </Menu>
  );
}
export function EditMenu({
  onAction,
  readOnly = false,
}: {
  onAction: (action: string) => void;
  readOnly?: boolean;
}) {
  return (
    <Menu label="Edit selection" icon={Copy}>
      {(
        [
          [Copy, 'copy', 'Copy'],
          [Scissors, 'cut', 'Cut'],
          [Clipboard, 'paste', 'Paste'],
          [Copy, 'duplicate', 'Duplicate'],
          [Trash2, 'delete', 'Delete'],
        ] as const
      ).map(([Icon, action, label]) => (
        <button
          key={action}
          disabled={readOnly && action !== 'copy'}
          onClick={() => onAction(action)}
        >
          <Icon size={17} />
          {label}
        </button>
      ))}
      <p className="hint">Clipboard stays inside this editor when system access is unavailable.</p>
    </Menu>
  );
}
export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [recent, setRecent] = useState<string[]>([]);
  const colors = [
    '#ffffff',
    '#253044',
    '#3267c8',
    '#559b82',
    '#eac46e',
    '#db7b7b',
    '#9474be',
    ...recent,
  ];
  return (
    <div className="color-field">
      <CommitInput
        label={label}
        value={value}
        onCommit={(v) => {
          if (/^(none|#[\da-f]{3,8})$/i.test(v)) {
            onChange(v);
            setRecent([v, ...recent.filter((c) => c !== v)].slice(0, 4));
          }
        }}
      />
      <div className="color-swatches">
        {colors.map((c, i) => (
          <button
            key={`${c}-${i}`}
            aria-label={`${label} ${c}`}
            title={c}
            style={{ background: c }}
            onClick={() => onChange(c)}
          />
        ))}
        <button aria-label={`${label} none`} onClick={() => onChange('none')}>
          ∅
        </button>
      </div>
    </div>
  );
}
export function VisualInspector({
  items,
  onPatch,
  onGeometry,
  onReplace,
}: {
  items: Drawing[];
  onPatch: (patch: Partial<VisualStyle> & { text?: string; fill?: string; src?: string }) => void;
  onGeometry: (patch: Partial<Bounds>) => void;
  onReplace?: (file: File) => void;
}) {
  const [ratio, setRatio] = useState(false);
  const textBridge = useContext(CanvasTextContext);
  const [crop, setCrop] = useState<{ x: number; y: number; scale: number }>();
  if (!items.length)
    return (
      <p className="hint">
        Select an object to edit its appearance. Double-click text to edit on the canvas.
      </p>
    );
  const first = items[0],
    mixed = (key: keyof Drawing) =>
      items.some((i) => JSON.stringify(i[key]) !== JSON.stringify(first[key]));
  const style = first.typography ?? {};
  const mixedStyle = (key: keyof typeof style) =>
    items.some((item) => item.typography?.[key] !== style[key]);
  const typography = (patch: Partial<typeof style>) => onPatch({ typography: patch });
  return (
    <>
      <Section title={`${items.length} selected · Geometry`}>
        <div className="ep-fields">
          {(['x', 'y', 'width', 'height'] as const).map((k) => (
            <CommitInput
              key={k}
              label={`Element ${k}`}
              type="number"
              min={k === 'width' || k === 'height' ? 1 : undefined}
              value={
                items.some((i) => i.bounds[k] !== first.bounds[k])
                  ? ''
                  : Math.round(first.bounds[k] * 100) / 100
              }
              placeholder="Mixed"
              onCommit={(v) => {
                const patch: Partial<Bounds> = { [k]: Number(v) };
                if (ratio && k === 'width')
                  patch.height = (first.bounds.height * Number(v)) / first.bounds.width;
                if (ratio && k === 'height')
                  patch.width = (first.bounds.width * Number(v)) / first.bounds.height;
                onGeometry(patch);
              }}
            />
          ))}
        </div>
        <label>
          <input type="checkbox" checked={ratio} onChange={(e) => setRatio(e.target.checked)} />{' '}
          Lock aspect ratio
        </label>
        <CommitInput
          label="Rotation (°)"
          type="number"
          value={mixed('rotation') ? '' : (first.rotation ?? 0)}
          placeholder="Mixed"
          onCommit={(v) => onPatch({ rotation: Number(v) % 360 })}
        />
        <p className="hint">
          Coordinates and dimensions in px. Positive sizes; negative positions allowed. Blank or
          invalid numbers are cancelled.
        </p>
      </Section>
      <Section title="Appearance">
        <ColorField
          label="Fill"
          value={mixed('fill') ? 'Mixed' : first.fill}
          onChange={(fill) => onPatch({ fill })}
        />
        <ColorField
          label="Stroke"
          value={mixed('stroke') ? 'Mixed' : (first.stroke ?? '#5b6472')}
          onChange={(stroke) => onPatch({ stroke })}
        />
        <div className="ep-fields">
          <CommitInput
            label="Stroke width (px)"
            type="number"
            min={0}
            value={mixed('strokeWidth') ? '' : (first.strokeWidth ?? 1)}
            placeholder="Mixed"
            onCommit={(v) => onPatch({ strokeWidth: Number(v) })}
          />
          <CommitInput
            label="Opacity (%)"
            type="number"
            min={0}
            max={100}
            value={mixed('opacity') ? '' : Math.round((first.opacity ?? 1) * 100)}
            onCommit={(v) => onPatch({ opacity: Number(v) / 100 })}
          />
          <CommitInput
            label="Corner radius (px)"
            type="number"
            min={0}
            value={mixed('radius') ? '' : (first.radius ?? 0)}
            placeholder="Mixed"
            onCommit={(v) => onPatch({ radius: Number(v) })}
          />
          <label className="ep-field">
            Dash
            <select
              aria-label="Stroke dash"
              value={mixed('dash') ? 'mixed' : (first.dash ?? '')}
              onChange={(e) => onPatch({ dash: e.target.value })}
            >
              {mixed('dash') && (
                <option value="mixed" disabled>
                  Mixed
                </option>
              )}
              <option value="">Solid</option>
              <option value="8 4">Dashed</option>
              <option value="2 3">Dotted</option>
            </select>
          </label>
        </div>
      </Section>
      {items.every((i) => i.kind !== 'image' && i.kind !== 'chart' && i.kind !== 'table') && (
        <Section title="Typography">
          <CommitInput
            label="Text"
            value={mixed('text') ? '' : first.text}
            placeholder="Mixed"
            onCommit={(text) => {
              if (!textBridge) onPatch({ text, runs: undefined });
              else
                for (const item of items) {
                  const engine = textBridge(item.id);
                  engine.dispatch(
                    canvasTextReplacement(engine.state, text, undefined, item.typography),
                  );
                }
            }}
          />
          <label className="ep-field">
            Font family
            <select
              aria-label="Font family"
              value={mixedStyle('fontFamily') ? '' : (style.fontFamily ?? 'Arial, sans-serif')}
              onChange={(e) => typography({ fontFamily: e.target.value })}
            >
              {mixedStyle('fontFamily') && (
                <option value="" disabled>
                  Mixed
                </option>
              )}
              <option>Arial, sans-serif</option>
              <option>Georgia, serif</option>
              <option>monospace</option>
            </select>
          </label>
          <div className="ep-fields">
            <CommitInput
              label="Font size (px)"
              type="number"
              min={8}
              max={300}
              value={mixedStyle('fontSize') ? '' : (style.fontSize ?? 28)}
              placeholder="Mixed"
              onCommit={(v) => typography({ fontSize: Number(v) })}
            />
            <CommitInput
              label="Line height"
              type="number"
              min={0.5}
              max={4}
              step={0.1}
              value={mixedStyle('lineHeight') ? '' : (style.lineHeight ?? 1.3)}
              placeholder="Mixed"
              onCommit={(v) => typography({ lineHeight: Number(v) })}
            />
            <CommitInput
              label="Letter spacing (px)"
              type="number"
              value={mixedStyle('letterSpacing') ? '' : (style.letterSpacing ?? 0)}
              placeholder="Mixed"
              onCommit={(v) => typography({ letterSpacing: Number(v) })}
            />
            <CommitInput
              label="Padding (px)"
              type="number"
              min={0}
              value={mixedStyle('padding') ? '' : (style.padding ?? 4)}
              placeholder="Mixed"
              onCommit={(v) => typography({ padding: Number(v) })}
            />
          </div>
          <div className="inline-actions">
            {(['bold', 'italic', 'underline', 'list'] as const).map((k) => (
              <button
                key={k}
                aria-pressed={mixedStyle(k) ? 'mixed' : (style[k] ?? false)}
                onClick={() => typography({ [k]: mixedStyle(k) || !style[k] })}
              >
                {k}
              </button>
            ))}
          </div>
          <ColorField
            label="Text color"
            value={mixedStyle('color') ? 'Mixed' : (style.color ?? '#253044')}
            onChange={(color) => typography({ color })}
          />
          <label className="ep-field">
            Text alignment
            <select
              aria-label="Text alignment"
              value={mixedStyle('align') ? '' : (style.align ?? 'left')}
              onChange={(e) => typography({ align: e.target.value as 'left' | 'center' | 'right' })}
            >
              {mixedStyle('align') && (
                <option value="" disabled>
                  Mixed
                </option>
              )}
              {['left', 'center', 'right'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="ep-field">
            Vertical alignment
            <select
              aria-label="Vertical alignment"
              value={mixedStyle('verticalAlign') ? '' : (style.verticalAlign ?? 'top')}
              onChange={(e) =>
                typography({ verticalAlign: e.target.value as 'top' | 'middle' | 'bottom' })
              }
            >
              {mixedStyle('verticalAlign') && (
                <option value="" disabled>
                  Mixed
                </option>
              )}
              {['top', 'middle', 'bottom'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="ep-field">
            Text overflow
            <select
              aria-label="Text overflow"
              value={mixedStyle('overflow') ? '' : (style.overflow ?? 'clip')}
              onChange={(e) =>
                typography({ overflow: e.target.value as 'clip' | 'expand' | 'fit' })
              }
            >
              {mixedStyle('overflow') && (
                <option value="" disabled>
                  Mixed
                </option>
              )}
              {['clip', 'expand', 'fit'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <p className="hint">
            Clip keeps the box; expand draws beyond it; fit reduces font size to 8 px minimum. All
            outputs share these rules.
          </p>
        </Section>
      )}
      {items.every((i) => i.kind === 'image') && (
        <Section title="Image">
          <CommitInput
            label="Image alt text"
            value={mixed('alt') ? '' : (first.alt ?? '')}
            placeholder="Mixed"
            onCommit={(alt) => onPatch({ alt })}
          />
          <label className="ep-field">
            Image fit
            <select
              aria-label="Image fit"
              value={mixed('imageFit') ? '' : (first.imageFit ?? 'fill')}
              onChange={(e) => onPatch({ imageFit: e.target.value as 'fit' | 'fill' })}
            >
              {mixed('imageFit') && (
                <option value="" disabled>
                  Mixed
                </option>
              )}
              <option value="fit">Fit entire image</option>
              <option value="fill">Fill and crop</option>
            </select>
          </label>
          <label className="ep-field">
            Replace image
            <input
              type="file"
              aria-label="Replace image file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onReplace?.(f);
              }}
            />
          </label>
          <button onClick={() => setCrop(first.crop ?? { x: 0, y: 0, scale: 1 })}>
            Crop image
          </button>
          {crop && (
            <div>
              <p>Crop adjustment — apply to commit</p>
              <img
                alt="Crop preview"
                style={{
                  width: '100%',
                  maxHeight: 180,
                  objectFit: 'contain',
                  background: '#e8edf5',
                }}
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawingSvg([{ ...first, crop, rotation: 0 }], first.bounds))}`}
              />
              {(['x', 'y', 'scale'] as const).map((k) => (
                <CommitInput
                  key={k}
                  label={`Crop ${k}`}
                  type="number"
                  min={k === 'scale' ? 0.1 : undefined}
                  step={k === 'scale' ? 0.1 : 1}
                  value={crop[k]}
                  onCommit={(v) => setCrop({ ...crop, [k]: Number(v) })}
                />
              ))}
              <button
                onClick={() => {
                  onPatch({ crop });
                  setCrop(undefined);
                }}
              >
                Apply crop
              </button>
              <button onClick={() => setCrop(undefined)}>Cancel crop</button>
            </div>
          )}
          <button
            onClick={() =>
              onPatch({
                crop: { x: 0, y: 0, scale: 1 },
                flipX: false,
                flipY: false,
                imageFit: 'fit',
              })
            }
          >
            Reset image
          </button>
        </Section>
      )}
    </>
  );
}
export function ExportMenu({
  onExport,
  children,
}: {
  onExport: (format: 'svg' | 'png' | 'pdf', scope: string, scale: number) => void;
  children?: ReactNode;
}) {
  const [scope, setScope] = useState('current'),
    [scale, setScale] = useState(1);
  return (
    <Menu label="Export visual" icon={Download} align="right">
      <label className="ep-field">
        Scope
        <select aria-label="Export scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="current">Current page / frame</option>
          <option value="selected">Selected</option>
          <option value="all">All</option>
        </select>
      </label>
      <label className="ep-field">
        Resolution
        <select
          aria-label="Export resolution"
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
        >
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
      </label>
      {(['svg', 'png', 'pdf'] as const).map((f) => (
        <button key={f} onClick={() => onExport(f, scope, scale)}>
          <Square size={16} />
          Export {f.toUpperCase()}
        </button>
      ))}
      {children}
    </Menu>
  );
}
