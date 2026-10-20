import type { RefObject } from 'react';
import { Plus, Download } from 'lucide-react';
import { referenceExportManifest } from '@editor-platform/artifact-references';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { ReferenceSurfaceProps } from '@editor-platform/artifact-references/react';
import { descendantIds, unionBounds, type EditorCommand } from '@editor-platform/editor-core';
import { CommitInput, Dialog, Menu, Section } from '@editor-platform/editor-ui';
import { LayerNavigator, exportPages, type CanvasTarget } from '@editor-platform/canvas-ui';
import {
  appearance,
  applyFramePreset,
  arrangeDesign,
  designPaintOrder,
  exportDesignSvg,
  insertInstance,
  patchDesign,
  reparentElement,
  type DesignContent,
  type DesignDrawing,
  type DesignElement,
} from './model';
import type { DesignSurfaceExtension } from './view';
import { designPaintBounds } from './paint-bounds';
import type { designRenderSnapshot } from './render-cache';
import type { FramePresetRequest } from './view-inspector';

// Pieces of the Design surface that do not own state; the surface passes its state in.

type Apply = (cmd: EditorCommand<DesignContent>) => boolean;

export const instanceTextKey = (drawing: DesignDrawing) =>
  drawing.instanceText &&
  JSON.stringify([drawing.instanceText.elementId, ...drawing.instanceText.partIds]);

export interface ScopedText {
  rootId: string;
  partIds: readonly string[];
  target: NonNullable<CanvasTarget['textParts']>[number];
}
/** Editable text inside component instances, addressed by IDs that cannot alias native elements. */
export function collectScopedTexts(
  content: DesignContent,
  project: (element: DesignElement) => DesignDrawing[],
): Map<string, ScopedText> {
  const map = new Map<string, ScopedText>();
  for (const root of content.elements.filter((e) => e.type === 'instance')) {
    const drawings = project(root);
    for (const drawing of drawings)
      if (drawing.instanceText) {
        const part = drawing.instanceText;
        const key = instanceTextKey(drawing)!;
        let id = `instance-text:${key}`;
        while (content.elements.some((e) => e.id === id)) id = `:${id}`;
        map.set(id, {
          rootId: root.id,
          partIds: part.partIds,
          target: {
            id,
            drawingId: key,
            label: `Component text ${part.name}`,
            bounds: drawing.bounds,
            rotation: drawing.rotation,
            text: drawing.text ?? '',
            typography: drawing.typography,
            runs: drawing.runs,
            textDrawing: drawing,
          },
        });
      }
  }
  return map;
}

export interface DesignExportState {
  content: DesignContent;
  ids: string[];
  padding: number;
  transparent: boolean;
  scale: number;
  extension?: DesignSurfaceExtension;
  references: ReferenceSurfaceProps['references'];
}
interface InputSnapshotSource {
  getSnapshot(): { dirty?: unknown; composing?: unknown };
}
function exportGroups(content: DesignContent, ids: string[], scope: string): string[][] {
  if (scope === 'frames')
    return content.elements.filter((e) => e.type === 'frame').map((e) => [e.id]);
  if (scope === 'selection') return [ids];
  return [content.elements.map((e) => e.id)];
}
/** Captures referenced images; rejects when references or inputs changed while capturing. */
async function captureReferences(
  content: DesignContent,
  exported: DesignElement[],
  state: RefObject<DesignExportState>,
  references: ReferenceSurfaceProps['references'],
  inputs: InputSnapshotSource | null | undefined,
) {
  if (!references) throw new Error('参照付きの出力には参照接続が必要です。');
  const captured = await references.capture(exported);
  if (state.current!.references !== references)
    throw new Error('取得中に参照接続が変わりました。再実行してください。');
  if (
    state.current!.content !== content ||
    inputs?.getSnapshot().dirty ||
    inputs?.getSnapshot().composing
  )
    throw new Error('取得中に入力が変わりました。再実行してください。');
  const byId = new Map(captured.map((e) => [e.id, e]));
  return {
    exported: captured,
    content: { ...content, elements: content.elements.map((e) => byId.get(e.id) ?? e) },
  };
}
/** Exports the chosen scope from the latest surface state as SVG or PNG pages. */
export async function exportDesignGraphics(
  format: 'svg' | 'png',
  scope: string,
  state: RefObject<DesignExportState>,
  references: ReferenceSurfaceProps['references'],
  inputs: InputSnapshotSource | null | undefined,
) {
  const initial = state.current!;
  let content = initial.content;
  const { ids, padding, transparent, scale, extension } = initial;
  const groups = exportGroups(content, ids, scope);
  if (scope === 'selection' && !ids.length) throw new Error('Select elements to export');
  const included = descendantIds(content.elements, groups.flat());
  const visible = new Set(
    designPaintOrder(content)
      .filter((e) => !e.hidden)
      .map((e) => e.id),
  );
  let exported = content.elements.filter((e) => included.has(e.id) && visible.has(e.id));
  if (exported.some((e) => e.reference))
    ({ exported, content } = await captureReferences(content, exported, state, references, inputs));
  const pages = groups.map((group) => {
    extension?.beforeGraphicExport?.(group);
    const all = descendantIds(content.elements, group),
      box = unionBounds(
        designPaintOrder(content)
          .filter((e) => all.has(e.id) && !e.hidden)
          .map((e) => e.bounds),
      );
    return {
      name: group.length === 1 ? content.elements.find((e) => e.id === group[0])!.name : 'design',
      svg: exportDesignSvg(content, group, {
        padding,
        background: transparent ? undefined : '#ffffff',
      }),
      width: box.width + padding * 2,
      height: box.height + padding * 2,
    };
  });
  await exportPages(pages, format, scale, 'design', referenceExportManifest(exported));
}

export function DesignExportMenu({
  padding,
  setPadding,
  transparent,
  setTransparent,
  scale,
  setScale,
  output,
}: {
  padding: number;
  setPadding: (padding: number) => void;
  transparent: boolean;
  setTransparent: (transparent: boolean) => void;
  scale: number;
  setScale: (scale: number) => void;
  output: (format: 'svg' | 'png', scope: string) => Promise<void>;
}) {
  return (
    <Menu label="Export design" icon={Download}>
      <CommitInput
        label="Export padding (px)"
        type="number"
        min={0}
        value={padding}
        onCommit={(v) => setPadding(Number(v))}
      />
      <label>
        <input
          type="checkbox"
          checked={transparent}
          onChange={(e) => setTransparent(e.target.checked)}
        />{' '}
        Transparent background
      </label>
      <select
        aria-label="Design export scale"
        value={scale}
        onChange={(e) => setScale(Number(e.target.value))}
      >
        <option value={1}>1×</option>
        <option value={2}>2×</option>
      </select>
      {(['svg', 'png'] as const).map((format) =>
        ['all', 'selection', 'frames'].map((scope) => (
          <button key={format + scope} onClick={() => void output(format, scope)}>
            Export {scope} {format.toUpperCase()}
          </button>
        )),
      )}
    </Menu>
  );
}

export function DesignNavigator({
  content,
  ids,
  readOnly,
  tab,
  setTab,
  choose,
  fit,
  apply,
  setPublication,
}: {
  content: DesignContent;
  ids: string[];
  readOnly: boolean;
  tab: string;
  setTab: (tab: string) => void;
  choose: (ids: string[]) => void;
  fit: (ids?: string[]) => void;
  apply: Apply;
  setPublication: (componentId: string) => void;
}) {
  return (
    <>
      <div className="navigator-tabs">
        <button onClick={() => setTab('layers')}>Layers</button>
        <button onClick={() => setTab('components')}>Components</button>
      </div>
      {tab === 'layers' ? (
        <LayerNavigator
          virtualize
          entries={content.elements.map((e) => ({ ...e, type: e.type }))}
          selected={ids}
          onSelect={choose}
          onRename={(id, name) => apply(patchDesign([id], { name }))}
          onState={(id, patch) => apply(patchDesign([id], patch))}
          onReparent={(id, parent) => apply(reparentElement(id, parent))}
          onReorder={(id, delta) => apply(arrangeDesign([id], delta < 0 ? 'backward' : 'forward'))}
          readOnly={readOnly}
        />
      ) : (
        content.components.map((c) => (
          <div className="component-card" key={c.id}>
            <strong>{c.name}</strong>
            <button disabled={readOnly} onClick={() => setPublication(c.id)}>
              React公開設定 {c.name}
            </button>
            <button disabled={readOnly} onClick={() => apply(insertInstance(c.id))}>
              <Plus size={14} /> Insert {c.name}
            </button>
          </div>
        ))
      )}
      <Section title="Frames">
        {content.elements
          .filter((e) => e.type === 'frame')
          .map((e) => (
            <button
              key={e.id}
              onClick={() => {
                choose([e.id]);
                fit([e.id]);
              }}
            >
              {e.name}
            </button>
          ))}
      </Section>
    </>
  );
}

export function FramePresetDialog({
  preset,
  content,
  readOnly,
  apply,
  close,
}: {
  preset: FramePresetRequest;
  content: DesignContent;
  readOnly: boolean;
  apply: Apply;
  close: () => void;
}) {
  const flow = ['row', 'column'].includes(
    content.elements.find((element) => element.id === preset.id)?.layout?.direction ?? 'absolute',
  );
  return (
    <Dialog title="Frame preset constraints" onClose={close}>
      <p>
        Hugは子要素から寸法を計算するため、{preset.width}×{preset.height}
        と競合します。固定寸法へ切り替える方法を選んでください。
      </p>
      <button
        disabled={readOnly}
        onClick={() => {
          if (apply(applyFramePreset(preset.id, preset.width, preset.height))) close();
        }}
      >
        Use fixed frame size
      </button>
      <button
        disabled={readOnly || !flow}
        onClick={() => {
          if (apply(applyFramePreset(preset.id, preset.width, preset.height, true))) close();
        }}
      >
        Fit children to fixed frame
      </button>
      {!flow && (
        <p>
          絶対配置では子要素の自動調整を利用できません。Use fixed frame
          sizeでフレーム寸法を変更してください。
        </p>
      )}
      <button onClick={close}>Cancel preset</button>
    </Dialog>
  );
}

type DesignProjector = ReturnType<typeof designRenderSnapshot>;
/** Canvas hit/paint targets in native paint order; Host-owned subtrees paint through their owner. */
export function designCanvasTargets(
  content: DesignContent,
  project: DesignProjector,
  canvasOwners: Map<string, string | undefined>,
  scopedTexts: Map<string, ScopedText>,
  extension: DesignSurfaceExtension | undefined,
): CanvasTarget[] {
  return designPaintOrder(content)
    .filter((e) => !canvasOwners.get(e.id))
    .map((e) => ({
      ...e,
      label: `Design object ${e.name}`,
      paintBounds: extension?.render
        ? undefined
        : designPaintBounds(project(e), e.bounds, e.rotation),
      text: appearance(content, e).text,
      textDrawing: project(e).find((drawing) => drawing.id === e.id),
      editableText: e.type === 'text' || e.type === 'shape' || e.type === 'rectangle',
      hitBox: e.type === 'text' || e.type === 'instance' || e.type === 'react',
      container: e.type === 'group',
      textParts: [...scopedTexts.values()].filter((p) => p.rootId === e.id).map((p) => p.target),
    }));
}
/** A scoped text changed after editing began; the pending input must not overwrite it. */
export const scopedTextChanged = (part: ScopedText, base: { text: string; runs?: unknown }) =>
  canonicalJson([part.target.text, part.target.runs ?? null]) !==
  canonicalJson([base.text, base.runs ?? null]);
/** Drawings for one canvas target, hiding the instance text currently being edited in place. */
export function targetDrawings(
  raw: DesignElement,
  target: CanvasTarget & { editingTextId?: string },
  project: DesignProjector,
  referenceSrc: string | undefined,
): DesignDrawing[] {
  return project(raw, target.bounds, target.rotation).map((original) => {
    const drawing = raw.reference ? { ...original, src: referenceSrc } : original;
    return target.textParts?.some(
      (part) => part.id === target.editingTextId && part.drawingId === instanceTextKey(drawing),
    )
      ? { ...drawing, text: '', runs: undefined }
      : drawing;
  });
}
