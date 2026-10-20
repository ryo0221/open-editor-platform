import { useState } from 'react';
import { ReferenceInspector } from '@editor-platform/artifact-references/react';
import { CommitInput, Section } from '@editor-platform/editor-ui';
import { readImage, VisualInspector } from '@editor-platform/canvas-ui';
import type { Bounds } from '@editor-platform/editor-core';
import type { PlayableAnimationEmbed } from '@editor-platform/animation-core/v2';
import { AnimationObjectInspector, type SlideAnimationProps } from './animation';
import {
  patchObjects,
  replaceSlideAnimation,
  resizeDeck,
  slideDrawing,
  updateObject,
  updateSlide,
  type ChartSnapshot,
  type Slide,
  type SlideObject,
} from './model';
import type { SlideEditing } from './view-shared';
export interface SlideInspectorProps {
  editing: SlideEditing;
  chosen: SlideObject[];
  onGeometry(patch: Partial<Bounds>): void;
  /** Present when the Host offers Animation sources. */
  onChooseAnimation?: (object: SlideObject) => void;
  onPreviewAnimation(animation: PlayableAnimationEmbed | undefined): void;
  openAnimation?: SlideAnimationProps['openAnimation'];
}
export function SlideInspector(props: SlideInspectorProps) {
  const { editing, chosen } = props;
  const { slide, readOnly, apply } = editing;
  const object = chosen.length === 1 ? chosen[0] : undefined;
  return (
    <>
      {object?.animation && slide && (
        <AnimationObjectInspector
          object={object}
          pageId={slide.id}
          readOnly={readOnly}
          patch={(animation) =>
            apply(replaceSlideAnimation(slide.id, object.id, object.animation!, animation))
          }
          choose={props.onChooseAnimation ? () => props.onChooseAnimation!(object) : undefined}
          preview={() => props.onPreviewAnimation(object.animation)}
          openSource={props.openAnimation}
        />
      )}
      <ReferenceInspector
        item={object}
        pageId={slide?.id}
        resolver={editing.references}
        readOnly={readOnly}
        patch={(patch) =>
          object &&
          slide &&
          apply(
            updateObject(slide.id, object.id, {
              ...patch,
              imageFit: (patch.reference ?? object.reference)?.fit === 'cover' ? 'fill' : 'fit',
            }),
          )
        }
      />
      <fieldset disabled={readOnly} className="inspector-fields">
        {slide && <SlideFields {...props} slide={slide} object={object} />}
      </fieldset>
    </>
  );
}
function SlideFields({
  editing,
  chosen,
  onGeometry,
  slide,
  object,
}: SlideInspectorProps & { slide: Slide; object: SlideObject | undefined }) {
  const { apply, ids } = editing;
  return (
    <>
      <PageSettings editing={editing} slide={slide} open={!chosen.length} />
      <VisualInspector
        items={chosen.map(slideDrawing)}
        imageEditing={!chosen.some((item) => item.type === 'animation')}
        onPatch={(patch) => apply(patchObjects(slide.id, ids, patch))}
        onGeometry={onGeometry}
        onReplace={(f) => {
          void readImage(f)
            .then((src) => apply(patchObjects(slide.id, ids, { src, reference: undefined })))
            .catch((e) => editing.setError(String(e)));
        }}
      />
      {object?.type === 'table' && object.table && (
        <TableInspector
          object={object}
          onChange={(table) => apply(updateObject(slide.id, object.id, { table }))}
        />
      )}
      {object?.type === 'chart' && object.chart && (
        <ChartDataSection editing={editing} slide={slide} object={object} chart={object.chart} />
      )}
      <Section title="Speaker notes" open={false}>
        <CommitInput
          label="Speaker notes"
          value={slide.notes ?? ''}
          onCommit={(notes) => apply(updateSlide(slide.id, { notes }))}
        />
      </Section>
    </>
  );
}
function PageSettings({
  editing,
  slide,
  open,
}: {
  editing: SlideEditing;
  slide: Slide;
  open: boolean;
}) {
  const { content, apply } = editing;
  return (
    <Section title="Page settings" open={open}>
      <CommitInput
        label="Slide title"
        value={slide.title}
        onCommit={(title) => apply(updateSlide(slide.id, { title }))}
      />
      <label className="ep-field">
        Page size
        <select
          aria-label="Slide size"
          value={`${content.width}x${content.height}`}
          onChange={(e) => {
            const [width, height] = e.target.value.split('x').map(Number);
            apply(resizeDeck(width, height));
          }}
        >
          <option value={`${content.width}x${content.height}`}>
            {content.width} × {content.height}
          </option>
          <option value="960x540">16:9</option>
          <option value="960x720">4:3</option>
        </select>
      </label>
      <div className="ep-fields">
        {(['width', 'height'] as const).map((k) => (
          <CommitInput
            key={k}
            label={`Page ${k} (px)`}
            type="number"
            min={100}
            max={6000}
            value={content[k]}
            onCommit={(v) =>
              apply(
                resizeDeck(
                  k === 'width' ? Number(v) : content.width,
                  k === 'height' ? Number(v) : content.height,
                ),
              )
            }
          />
        ))}
      </div>
      <p className="ep-muted">
        Changing page size keeps object positions and sizes. Content outside the page is clipped in
        presentation and export.
      </p>
      <CommitInput
        label="Slide background"
        value={slide.background}
        onCommit={(background) => apply(updateSlide(slide.id, { background }))}
      />
      <label>
        <input
          type="checkbox"
          checked={slide.hidden ?? false}
          onChange={(e) => apply(updateSlide(slide.id, { hidden: e.target.checked }))}
        />{' '}
        Skip during presentation
      </label>
    </Section>
  );
}
function ChartDataSection({
  editing,
  slide,
  object,
  chart,
}: {
  editing: SlideEditing;
  slide: Slide;
  object: SlideObject;
  chart: ChartSnapshot;
}) {
  const { apply } = editing;
  return (
    <Section title="Chart data">
      <label className="ep-field">
        Chart type
        <select
          aria-label="Chart type"
          value={chart.type ?? 'bar'}
          onChange={(e) =>
            apply(
              updateObject(slide.id, object.id, {
                chart: { ...chart, type: e.target.value as 'bar' | 'line' | 'pie' },
              }),
            )
          }
        >
          {['bar', 'line', 'pie'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <ChartEditor
        chart={chart}
        onChange={(chart) => apply(updateObject(slide.id, object.id, { chart }))}
      />
      <p className="hint">
        Imported charts are static snapshots. Edit these values explicitly; source data changes do
        not alter this slide.
      </p>
    </Section>
  );
}
function ChartEditor({
  chart,
  onChange,
}: {
  chart: ChartSnapshot;
  onChange: (c: ChartSnapshot) => void;
}) {
  const [draft, setDraft] = useState(
      chart.labels.map((label, i) => `${label}\t${chart.values[i]}`).join('\n'),
    ),
    [error, setError] = useState('');
  return (
    <>
      <CommitInput
        label="Chart title"
        value={chart.label}
        onCommit={(label) => onChange({ ...chart, label })}
      />
      <label className="ep-field">
        Label and value (tab-separated)
        <textarea
          aria-label="Chart data"
          rows={6}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <button
        onClick={() => {
          const rows = draft
            .split('\n')
            .filter(Boolean)
            .map((l) => l.split('\t'));
          if (rows.some((r) => r.length !== 2 || !Number.isFinite(Number(r[1])))) {
            setError('Each row needs a label, a tab and a finite number.');
            return;
          }
          onChange({
            ...chart,
            labels: rows.map((r) => r[0]),
            values: rows.map((r) => Number(r[1])),
            capturedAt: new Date().toISOString(),
          });
          setError('');
        }}
      >
        Apply chart data
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
function TableInspector({
  object,
  onChange,
}: {
  object: SlideObject;
  onChange: (table: NonNullable<SlideObject['table']>) => void;
}) {
  const table = object.table!,
    [row, setRow] = useState(0),
    [col, setCol] = useState(0),
    [rows, setRows] = useState(1),
    [cols, setCols] = useState(2);
  return (
    <Section title="Table">
      <div className="table-edit">
        {table.rows.map((r, ri) => (
          <div key={ri}>
            {r.map((v, ci) => (
              <CommitInput
                key={ci}
                label={`Cell ${ri + 1},${ci + 1}`}
                value={v}
                onCommit={(value) =>
                  onChange({
                    ...table,
                    rows: table.rows.map((r, i) =>
                      i === ri ? r.map((v, j) => (j === ci ? value : v)) : r,
                    ),
                  })
                }
              />
            ))}
          </div>
        ))}
      </div>
      <button
        onClick={() =>
          onChange({
            ...table,
            rows: [...table.rows, Array(table.rows[0].length).fill('')],
            rowHeights: undefined,
          })
        }
      >
        Add table row
      </button>
      <button
        onClick={() =>
          onChange({ ...table, rows: table.rows.map((r) => [...r, '']), columnWidths: undefined })
        }
      >
        Add table column
      </button>
      <div className="ep-fields">
        <CommitInput
          label="Table row"
          type="number"
          min={1}
          max={table.rows.length}
          value={row + 1}
          onCommit={(v) => setRow(Number(v) - 1)}
        />
        <CommitInput
          label="Table column"
          type="number"
          min={1}
          max={table.rows[0].length}
          value={col + 1}
          onCommit={(v) => setCol(Number(v) - 1)}
        />
        <CommitInput
          label="Merge rows"
          type="number"
          min={1}
          value={rows}
          onCommit={(v) => setRows(Number(v))}
        />
        <CommitInput
          label="Merge columns"
          type="number"
          min={1}
          value={cols}
          onCommit={(v) => setCols(Number(v))}
        />
      </div>
      <button
        disabled={table.rows.length <= 1}
        onClick={() =>
          onChange({
            ...table,
            rows: table.rows.filter((_, i) => i !== row),
            merges: [],
            rowHeights: undefined,
          })
        }
      >
        Delete table row
      </button>
      <button
        disabled={table.rows[0].length <= 1}
        onClick={() =>
          onChange({
            ...table,
            rows: table.rows.map((r) => r.filter((_, i) => i !== col)),
            merges: [],
            columnWidths: undefined,
          })
        }
      >
        Delete table column
      </button>
      <button
        onClick={() =>
          onChange({
            ...table,
            merges: [
              ...(table.merges ?? []).filter((m) => m.row !== row || m.col !== col),
              {
                row,
                col,
                rows: Math.min(rows, table.rows.length - row),
                cols: Math.min(cols, table.rows[0].length - col),
              },
            ],
          })
        }
      >
        Merge cells
      </button>
      <button
        onClick={() =>
          onChange({
            ...table,
            merges: (table.merges ?? []).filter((m) => m.row !== row || m.col !== col),
          })
        }
      >
        Split cell
      </button>
    </Section>
  );
}
