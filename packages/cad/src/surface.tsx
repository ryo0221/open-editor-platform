import {
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import {
  Box,
  Circle,
  Cylinder,
  ImageDown,
  Redo2,
  RectangleHorizontal,
  RefreshCw,
  Scan,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  CommitInput,
  EditorLayout,
  IconButton,
  Section,
  Toolbar,
  EditorExportGuardContext,
  EditorHistoryContext,
  isTextInput,
  modKey,
} from '@editor-platform/editor-ui';
import {
  lengthParameter,
  parameterValues,
  resolveLength,
  resolvePosition,
  type CadBody,
  type CadDocument,
  type CadFeature,
  type Length,
} from '@editor-platform/cad-core';
import type { CadController, CadSnapshot } from './controller';
import { CadViewport } from './viewport';
import './style.css';

const fmt = (n: number, digits = 3) =>
  Math.abs(n) < 1e-12 ? '0' : Number(n.toFixed(digits)).toString();
const placementOf = (doc: CadDocument, body: CadBody) =>
  doc.features.find((f) => f.id === body.resultFeatureId);
const stateText: Record<CadSnapshot['geometryState'], string> = {
  ready: 'Shape up to date',
  reevaluating: 'Recalculating shape…',
  'geometry-error': 'Shape could not be calculated',
};

function Viewport({
  controller,
  snapshot,
  view,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  view: RefObject<CadViewport | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    try {
      view.current = new CadViewport(host.current, {
        onPick: (bodyId) => controller.select(bodyId ? { kind: 'body', id: bodyId } : null),
        onContextLost: () => setLost(true),
      });
    } catch {
      setLost(true);
    }
    return () => {
      view.current?.dispose();
      view.current = null;
    };
  }, [controller, view]);
  useEffect(() => {
    const meshes = snapshot.meshes;
    const bodies = new Map(snapshot.content.bodies.map((b) => [b.id, b]));
    view.current?.show(
      (meshes?.meshes ?? []).flatMap((mesh) => {
        const body = bodies.get(mesh.bodyId);
        if (!body && meshes?.current) return [];
        return [
          {
            mesh,
            color: body?.appearance.color ?? '#9aa4b1',
            opacity: body?.appearance.opacity ?? 1,
            selected: snapshot.selection?.kind === 'body' && snapshot.selection.id === mesh.bodyId,
          },
        ];
      }),
      !!meshes?.current,
    );
  }, [snapshot.meshes, snapshot.selection, snapshot.content, view]);
  return (
    <div className="cad-viewport" data-testid="cad-viewport">
      <div ref={host} className="cad-canvas-host" />
      {lost && (
        <p className="cad-viewport-note" role="status">
          3D表示を利用できません。一覧とInspectorから編集・保存できます。
        </p>
      )}
      {!snapshot.content.bodies.some((b) => b.state === 'active') && (
        <p className="cad-viewport-note">Add a body from the toolbar to start.</p>
      )}
      <IconButton
        icon={Scan}
        label="Fit view"
        className="cad-fit"
        onClick={() => view.current?.fit()}
      />
    </div>
  );
}

function LengthField({
  label,
  length,
  doc,
  disabled,
  onCommit,
}: {
  label: string;
  length: Length;
  doc: CadDocument;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const parameter = lengthParameter(length);
  if (parameter || disabled) {
    const p = doc.parameters.find((x) => x.id === parameter);
    return (
      <div className="cad-readonly-field">
        <span>{label}</span>
        <output>
          {fmt(resolveLength(length, parameterValues(doc)))} mm{p ? ` (= ${p.name})` : ''}
        </output>
      </div>
    );
  }
  return (
    <CommitInput
      label={`${label} (mm)`}
      type="number"
      step={0.1}
      value={(length as { literalMm: number }).literalMm}
      onCommit={(v) => onCommit(Number(v))}
    />
  );
}

function FeatureArgs({
  feature,
  doc,
  controller,
}: {
  feature: CadFeature;
  doc: CadDocument;
  controller: CadController;
}) {
  const update = (args: CadFeature['args']) =>
    controller.run({ type: 'updateFeature', featureId: feature.id, args });
  const mm = (literalMm: number): Length => ({ literalMm });
  switch (feature.type) {
    case 'box': {
      const a = feature.args;
      return (
        <>
          {(['Width', 'Depth', 'Height'] as const).map((label, i) => (
            <LengthField
              key={label}
              label={label}
              length={a.size[i]}
              doc={doc}
              onCommit={(v) =>
                update({ ...a, size: a.size.map((l, j) => (j === i ? mm(v) : l)) as typeof a.size })
              }
            />
          ))}
        </>
      );
    }
    case 'cylinder':
      return (
        <>
          <LengthField
            label="Radius"
            length={feature.args.radius}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, radius: mm(v) })}
          />
          <LengthField
            label="Height"
            length={feature.args.height}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, height: mm(v) })}
          />
        </>
      );
    case 'sphere':
      return (
        <LengthField
          label="Radius"
          length={feature.args.radius}
          doc={doc}
          onCommit={(v) => update({ ...feature.args, radius: mm(v) })}
        />
      );
    case 'extrude':
      return (
        <LengthField
          label="Distance"
          length={feature.args.distance}
          doc={doc}
          onCommit={(v) => update({ ...feature.args, distance: mm(v) })}
        />
      );
    default:
      return <p className="cad-muted">No editable dimensions.</p>;
  }
}

function Inspector({ controller, snapshot }: { controller: CadController; snapshot: CadSnapshot }) {
  const { content: doc, selection, evaluation, readOnly } = snapshot;
  const [tool, setTool] = useState('');
  if (!selection) return <p className="cad-muted">Select a body, feature or parameter.</p>;
  const key = `${selection.id}:${snapshot.rejections}`;
  if (selection.kind === 'parameter') {
    const p = doc.parameters.find((x) => x.id === selection.id)!;
    return (
      <div className="cad-inspector" key={key}>
        <CommitInput
          label="Name"
          value={p.name}
          onCommit={(name) => void controller.run({ type: 'rename', targetId: p.id, name })}
        />
        <CommitInput
          label={p.type === 'length' ? 'Value (mm)' : 'Value (rad)'}
          type="number"
          step={0.1}
          value={p.value}
          onCommit={(v) =>
            void controller.run({ type: 'setParameter', parameterId: p.id, value: Number(v) })
          }
        />
      </div>
    );
  }
  if (selection.kind === 'feature') {
    const f = doc.features.find((x) => x.id === selection.id)!;
    return (
      <div className="cad-inspector" key={key}>
        <CommitInput
          label="Name"
          value={f.name}
          onCommit={(name) => void controller.run({ type: 'rename', targetId: f.id, name })}
        />
        <p className="cad-muted">Type: {f.type}</p>
        {!readOnly && <FeatureArgs feature={f} doc={doc} controller={controller} />}
      </div>
    );
  }
  const body = doc.bodies.find((b) => b.id === selection.id)!;
  const metrics = evaluation?.status === 'ok' ? evaluation.bodies[body.id] : undefined;
  const placement = placementOf(doc, body);
  const at =
    placement?.type === 'transform'
      ? resolvePosition(placement.args.translation, parameterValues(doc))
      : [0, 0, 0];
  const movable = !readOnly && controller.isMovable(body);
  const others = doc.bodies.filter((b) => b.state === 'active' && b.id !== body.id);
  return (
    <div className="cad-inspector" key={key}>
      <CommitInput
        label="Name"
        value={body.name}
        onCommit={(name) => void controller.run({ type: 'rename', targetId: body.id, name })}
      />
      <Section title="Placement">
        {(['X', 'Y', 'Z'] as const).map((axis, i) =>
          movable ? (
            <CommitInput
              key={axis}
              label={`${axis} (mm)`}
              type="number"
              step={1}
              value={at[i]}
              onCommit={(v) =>
                void controller.moveBody(
                  body,
                  at.map((x, j) => (j === i ? Number(v) : x)) as [number, number, number],
                )
              }
            />
          ) : (
            <div className="cad-readonly-field" key={axis}>
              <span>{axis}</span>
              <output>{fmt(at[i])} mm</output>
            </div>
          ),
        )}
      </Section>
      <Section title="Measurements">
        {metrics ? (
          <dl className="cad-metrics">
            <dt>Volume</dt>
            <dd>{fmt(metrics.volumeMm3)} mm³</dd>
            <dt>Area</dt>
            <dd>{fmt(metrics.areaMm2)} mm²</dd>
            <dt>Size</dt>
            <dd>
              {metrics.bounds[1].map((max, i) => fmt(max - metrics.bounds[0][i], 2)).join(' × ')} mm
            </dd>
          </dl>
        ) : (
          <p className="cad-muted">Available after the shape is calculated.</p>
        )}
      </Section>
      {!readOnly && body.state === 'active' && (
        <Section title="Combine">
          <label className="ep-field">
            With body
            <select value={tool} onChange={(e) => setTool(e.target.value)}>
              <option value="">Choose…</option>
              {others.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <div className="cad-row">
            {(['union', 'cut', 'common'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={!tool || snapshot.busy}
                onClick={() => void controller.combine(body.id, tool, mode).then(() => setTool(''))}
              >
                {mode === 'union' ? 'Union' : mode === 'cut' ? 'Cut' : 'Intersect'}
              </button>
            ))}
          </div>
        </Section>
      )}
      {!readOnly && (
        <button
          type="button"
          className="cad-danger"
          onClick={() =>
            void controller.run({ type: 'deleteClosure', ids: [body.id], cascade: false })
          }
        >
          <Trash2 size={16} aria-hidden="true" /> Delete body
        </button>
      )}
    </div>
  );
}

function Navigator({ controller, snapshot }: { controller: CadController; snapshot: CadSnapshot }) {
  const { content: doc, selection } = snapshot;
  const item = (
    kind: 'body' | 'feature' | 'parameter',
    id: string,
    label: string,
    extra?: string,
  ) => (
    <li key={id}>
      <button
        type="button"
        className="cad-item"
        aria-pressed={selection?.kind === kind && selection.id === id}
        onClick={() => controller.select({ kind, id })}
      >
        {label}
        {extra && <small>{extra}</small>}
      </button>
    </li>
  );
  const active = doc.bodies.filter((b) => b.state === 'active');
  return (
    <nav className="cad-navigator" aria-label="CAD elements">
      <Section title={`Bodies (${active.length})`}>
        <ul aria-label="Bodies">{active.map((b) => item('body', b.id, b.name))}</ul>
      </Section>
      <Section title={`Parameters (${doc.parameters.length})`}>
        <ul aria-label="Parameters">
          {doc.parameters.map((p) =>
            item(
              'parameter',
              p.id,
              p.name,
              `${fmt(p.value)} ${p.type === 'length' ? 'mm' : 'rad'}`,
            ),
          )}
        </ul>
      </Section>
      <Section title={`History (${doc.features.length})`} open={false}>
        <ol aria-label="Feature history">
          {doc.features.map((f) => item('feature', f.id, f.name, f.type))}
        </ol>
      </Section>
    </nav>
  );
}

/** The Surface that window-level shortcuts belong to when focus is outside every Surface. */
let activeSurface: HTMLElement | null = null;

/** CAD Surface. All edits go through the controller's prepare → apply boundary. */
export interface CadSurfaceProps {
  controller: CadController;
  /**
   * The Host owns Undo/Redo and calls `controller.sync()` afterwards. Ctrl/Cmd+Z on this Surface
   * goes to `EditorHistoryContext` when the Host provides one.
   */
  hostHistory?: boolean;
  /** File name stem for PNG export. */
  name?: string;
  /** Receives the exported PNG; without it the Surface offers a download. */
  onExportPng?(png: Blob): void;
}
export function CadSurface({
  controller,
  hostHistory,
  name = 'cad',
  onExportPng,
}: CadSurfaceProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const view = useRef<CadViewport | null>(null);
  const { readOnly, busy } = snapshot;
  const disabled = readOnly || busy;
  // PNG shows exactly the confirmed content: only when its own meshes are displayed and no
  // edit is still evaluating.
  const exportable = !!snapshot.meshes?.current && snapshot.geometryState === 'ready' && !busy;
  const guardExport = useContext(EditorExportGuardContext);
  async function exportPng() {
    // The Host guard flushes pending inputs first; a field it commits starts a new evaluation.
    try {
      guardExport?.();
    } catch (error) {
      return controller.report(error instanceof Error ? error.message : String(error));
    }
    const now = controller.getSnapshot();
    if (now.busy || !now.meshes?.current || now.geometryState !== 'ready')
      return controller.report('形状を計算中です。計算が終わってから、もう一度操作してください。');
    const png = await view.current?.capture();
    if (!png) return;
    if (onExportPng) return onExportPng(png);
    const url = URL.createObjectURL(png);
    const link = Object.assign(document.createElement('a'), { href: url, download: `${name}.png` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  useEffect(() => {
    void controller.refresh();
  }, [controller]);
  const root = useRef<HTMLDivElement>(null);
  const hostHistoryContext = useContext(EditorHistoryContext);
  const history = hostHistory
    ? hostHistoryContext
    : { undo: () => void controller.undo(), redo: () => void controller.redo() };
  const historyRef = useRef(history);
  historyRef.current = history;
  // Window-level, like the Playground, so shortcuts still work after focus falls back to <body>.
  // With several Surfaces mounted, only the one last used (or the first mounted) answers.
  useEffect(() => {
    const element = root.current!;
    activeSurface ??= element;
    const activate = () => (activeSurface = element);
    element.addEventListener('pointerdown', activate, true);
    element.addEventListener('focusin', activate);
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
      const owner = e.target instanceof Element ? e.target.closest('.cad-surface') : null;
      if (owner ? owner !== element : activeSurface !== element) return;
      const history = historyRef.current;
      if (history && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      } else if (e.key === 'Escape' && controller.getSnapshot().selection) controller.select(null);
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      element.removeEventListener('pointerdown', activate, true);
      element.removeEventListener('focusin', activate);
      if (activeSurface === element) activeSurface = null;
    };
  }, [controller]);
  return (
    <div className="cad-surface" ref={root}>
      <EditorLayout
        viewKey="cad"
        leftLabel="Elements"
        toolbar={
          <Toolbar label="CAD tools">
            {!hostHistory && (
              <>
                <IconButton
                  icon={Undo2}
                  label="Undo"
                  shortcut={`${modKey()}+Z`}
                  disabled={readOnly || !snapshot.canUndo}
                  onClick={() => void controller.undo()}
                />
                <IconButton
                  icon={Redo2}
                  label="Redo"
                  shortcut={`${modKey()}+Shift+Z`}
                  disabled={readOnly || !snapshot.canRedo}
                  onClick={() => void controller.redo()}
                />
              </>
            )}
            <IconButton
              icon={Box}
              label="Add box"
              disabled={disabled}
              onClick={() => void controller.addPrimitive('box')}
            />
            <IconButton
              icon={Cylinder}
              label="Add cylinder"
              disabled={disabled}
              onClick={() => void controller.addPrimitive('cylinder')}
            />
            <IconButton
              icon={Circle}
              label="Add sphere"
              disabled={disabled}
              onClick={() => void controller.addPrimitive('sphere')}
            />
            <IconButton
              icon={RectangleHorizontal}
              label="Add plate"
              reason="Extruded rectangle with a width parameter"
              disabled={disabled}
              onClick={() => void controller.addPlate()}
            />
            <IconButton
              icon={ImageDown}
              label="Export PNG"
              reason="Available when the shape is up to date"
              disabled={!exportable}
              onClick={() => void exportPng()}
            />
            {snapshot.geometryState === 'geometry-error' && (
              <IconButton
                icon={RefreshCw}
                label="Recalculate"
                onClick={() => void controller.refresh({ retry: true })}
              />
            )}
          </Toolbar>
        }
        left={<Navigator controller={controller} snapshot={snapshot} />}
        inspector={
          // Fields stay disabled while an edit evaluates: a second edit built from the still
          // committed values would silently supersede the pending one.
          <fieldset className="cad-inspector-scope" disabled={busy}>
            <Inspector controller={controller} snapshot={snapshot} />
          </fieldset>
        }
        status={
          <div className="cad-status" aria-live="polite">
            <span>mm</span>
            <span data-testid="cad-geometry-state">
              {busy ? 'Calculating…' : stateText[snapshot.geometryState]}
            </span>
            {readOnly && <span>Read only</span>}
            {snapshot.diagnostic && (
              <span role="alert" className="cad-diagnostic">
                {snapshot.diagnostic.message}
                <button
                  type="button"
                  aria-label="Dismiss message"
                  onClick={() => controller.dismissDiagnostic()}
                >
                  ×
                </button>
              </span>
            )}
          </div>
        }
      >
        <Viewport controller={controller} snapshot={snapshot} view={view} />
      </EditorLayout>
    </div>
  );
}
