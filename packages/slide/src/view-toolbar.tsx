import { useContext, useId } from 'react';
import { ReferenceTools } from '@editor-platform/artifact-references/react';
import { EditorOfficeCapabilitiesContext, IconButton, Menu } from '@editor-platform/editor-ui';
import {
  ArrangeMenu,
  CanvasControls,
  EditMenu,
  ExportMenu,
  InsertTools,
  type CanvasView,
} from '@editor-platform/canvas-ui';
import type { ShapeKind } from '@editor-platform/editor-core';
import {
  ChartColumn,
  ChevronLeft,
  ChevronRight,
  LayoutTemplate,
  Plus,
  Presentation,
  Repeat,
  Table2,
} from 'lucide-react';
import {
  alignObjects,
  hasSlideReuse,
  type ChartSnapshot,
  type SlideInsertType,
  type SlideLayout,
  type SlideObject,
} from './model';
import type { SlideEditing } from './view-shared';
export const animationReuseReason =
  '再利用部品・テンプレート・表示モードを含む Slide への Animation 配置は未対応です。';
export type SlideObjectPatch = Partial<Omit<SlideObject, 'type' | 'animation'>>;
export interface SlideToolbarProps {
  editing: SlideEditing;
  /** Present when the Host offers Animation sources. */
  onChooseAnimation?: () => void;
  dataSnapshots: ChartSnapshot[];
  inserting: ShapeKind | undefined;
  setInserting(shape: ShapeKind | undefined): void;
  repeat: boolean;
  setRepeat(repeat: boolean): void;
  reference: string;
  setReference(reference: string): void;
  onAdd(type: SlideInsertType, patch?: SlideObjectPatch): void;
  onImage(file: File): void;
  onAction(action: string, value?: number): void;
  onAddSlide(layout: SlideLayout): void;
  onPresent(): void;
  onExport(format: 'svg' | 'png' | 'pdf', scope: string, scale: number): void;
  onPptx(): void;
}
export function SlideToolbar(props: SlideToolbarProps) {
  const { editing, onAdd, onAction, reference } = props;
  const { content, slide, ids, readOnly, apply } = editing;
  return (
    <>
      {props.onChooseAnimation && (
        <AnimationPlacement editing={editing} onChoose={props.onChooseAnimation} />
      )}
      <ReferenceTools
        identity={slide?.id}
        resolver={editing.references}
        readOnly={readOnly}
        insert={(reference, src, label) =>
          onAdd('image', {
            reference,
            src,
            alt: label,
            imageFit: 'fit',
            bounds: { x: 80, y: 140, width: 700, height: 320 },
          })
        }
      />
      <InsertTools
        readOnly={readOnly}
        onShape={(s) => {
          onAdd('shape', { shape: s });
          props.setInserting(undefined);
        }}
        onText={() => onAdd('text')}
        onImage={props.onImage}
      />
      <InsertOptionsMenu {...props} />
      <span className="ep-divider" />
      <ArrangeMenu
        count={ids.length}
        readOnly={readOnly}
        onAction={onAction}
        onAlign={(mode) =>
          slide &&
          apply(
            alignObjects(
              slide.id,
              ids,
              mode,
              reference === 'page'
                ? { x: 0, y: 0, width: content.width, height: content.height }
                : undefined,
            ),
          )
        }
        reference={reference}
        onReference={props.setReference}
      />
      <EditMenu onAction={onAction} readOnly={readOnly} />
      <SlideLayoutMenu readOnly={readOnly} onAddSlide={props.onAddSlide} />
      <IconButton
        icon={Presentation}
        label="Present"
        disabled={!content.slides.length}
        onClick={props.onPresent}
      />
      <ExportMenu onExport={props.onExport}>
        <PptxExportButton editing={editing} onPptx={props.onPptx} />
      </ExportMenu>
    </>
  );
}
function AnimationPlacement({ editing, onChoose }: { editing: SlideEditing; onChoose(): void }) {
  const reasonId = useId();
  const reason = hasSlideReuse(editing.content) ? animationReuseReason : undefined;
  return (
    <>
      <button
        disabled={editing.readOnly || !editing.slide || !!reason}
        aria-describedby={reason ? reasonId : undefined}
        onClick={onChoose}
      >
        アニメーションを配置
      </button>
      {reason && (
        <span id={reasonId} role="note">
          {reason}
        </span>
      )}
    </>
  );
}
const drawableShapes = [
  'rectangle',
  'rounded-rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'arrow-right',
];
function InsertOptionsMenu({
  editing,
  onAdd,
  inserting,
  setInserting,
  repeat,
  setRepeat,
  dataSnapshots,
}: SlideToolbarProps) {
  return (
    <Menu label="Slide insert options" icon={Plus}>
      <button
        disabled={editing.readOnly}
        onClick={() =>
          onAdd('table', {
            table: {
              rows: [
                ['Heading', 'Value'],
                ['', ''],
                ['', ''],
              ],
              header: true,
            },
            bounds: { x: 100, y: 150, width: 760, height: 300 },
          })
        }
      >
        <Table2 size={18} />
        Insert table
      </button>
      <button
        disabled={editing.readOnly}
        onClick={() => onAdd('chart', { bounds: { x: 120, y: 140, width: 720, height: 320 } })}
      >
        <ChartColumn size={18} />
        Insert chart
      </button>
      <label className="ep-field">
        Draw a shape by dragging
        <select
          aria-label="Draw shape"
          value={inserting ?? ''}
          onChange={(e) => setInserting((e.target.value as ShapeKind) || undefined)}
        >
          <option value="">Selection tool</option>
          {drawableShapes.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <button aria-pressed={repeat} onClick={() => setRepeat(!repeat)}>
        <Repeat size={17} />
        Continuous creation
      </button>
      {dataSnapshots.map((d, i) => (
        <button key={i} onClick={() => onAdd('chart', { chart: d })}>
          Insert snapshot: {d.label}
        </button>
      ))}
    </Menu>
  );
}
const slideLayouts: SlideLayout[] = [
  'blank',
  'title',
  'title-body',
  'two-column',
  'image-caption',
  'comparison',
  'chart',
];
function SlideLayoutMenu({
  readOnly,
  onAddSlide,
}: {
  readOnly: boolean;
  onAddSlide(layout: SlideLayout): void;
}) {
  return (
    <Menu label="Add slide layout" icon={LayoutTemplate}>
      {slideLayouts.map((l) => (
        <button key={l} disabled={readOnly} onClick={() => onAddSlide(l)}>
          {l}
        </button>
      ))}
    </Menu>
  );
}
function PptxExportButton({ editing, onPptx }: { editing: SlideEditing; onPptx(): void }) {
  const officeCapability = useContext(EditorOfficeCapabilitiesContext);
  const hasAnimations = editing.content.slides.some((page) =>
    page.objects.some((o) => o.type === 'animation'),
  );
  return (
    <button
      disabled={!officeCapability.pptx || hasAnimations}
      title={
        hasAnimations
          ? 'アニメーションを含む Slide の PPTX 出力は未対応です。native JSON で保存してください。'
          : !officeCapability.pptx
            ? (officeCapability.reason ?? 'Hostはこの形式の出力を提供していません。')
            : undefined
      }
      onClick={onPptx}
    >
      Export PPTX
    </button>
  );
}
export function SlideStatus({
  index,
  count,
  selected,
  view,
  setView,
  navigate,
}: {
  index: number;
  count: number;
  selected: number;
  view: CanvasView;
  setView(view: CanvasView): void;
  navigate(index: number): unknown;
}) {
  return (
    <>
      <IconButton
        icon={ChevronLeft}
        label="Previous slide"
        disabled={index <= 0}
        onClick={() => navigate(index - 1)}
      />
      <input
        aria-label="Current page"
        type="number"
        min={1}
        max={count}
        value={index + 1}
        onChange={(e) => navigate(Number(e.target.value) - 1)}
      />
      <span>/ {count}</span>
      <IconButton
        icon={ChevronRight}
        label="Next slide"
        disabled={index >= count - 1}
        onClick={() => navigate(index + 1)}
      />
      <span className="ep-spacer" />
      <span>{selected} selected</span>
      <CanvasControls
        view={view}
        onChange={setView}
        onFit={() => setView({ ...view, fit: true })}
      />
    </>
  );
}
