import { useContext, useRef } from 'react';
import { referenceExportManifest } from '@editor-platform/artifact-references';
import type { ReferenceSurfaceProps } from '@editor-platform/artifact-references/react';
import { EditorExportGuardContext, EditorInputsContext } from '@editor-platform/editor-ui';
import { exportPages } from '@editor-platform/canvas-ui';
import {
  whiteboardPaintOrder,
  type WhiteboardContent,
  type WhiteboardNode,
  type WhiteboardSection,
} from './model';
import { boardBounds, boardSelection } from './sections';
import { exportBoardSvg } from './export';

export interface BoardOutputState {
  content: WhiteboardContent;
  ids: string[];
  selectedSection?: WhiteboardSection;
  references: ReferenceSurfaceProps['references'];
}

/**
 * SVG/PNG export of the board, a selection or a Section. Export reads the latest
 * rendered state and fails if references, content or inputs change while referenced
 * images are captured.
 */
export function useBoardOutput(state: BoardOutputState, setError: (message: string) => void) {
  const guardExport = useContext(EditorExportGuardContext);
  const inputs = useContext(EditorInputsContext);
  const latest = useRef(state);
  latest.current = state;
  async function captureReferences(content: WhiteboardContent, exported: WhiteboardNode[]) {
    const { references } = latest.current;
    if (!references) throw new Error('参照付きの出力には参照接続が必要です。');
    const captured = await references.capture(exported);
    if (latest.current.references !== references)
      throw new Error('取得中に参照接続が変わりました。再実行してください。');
    if (
      latest.current.content !== content ||
      inputs?.getSnapshot().dirty ||
      inputs?.getSnapshot().composing
    )
      throw new Error('取得中に入力が変わりました。再実行してください。');
    return captured;
  }
  return async function output(format: 'svg' | 'png', scope: string) {
    try {
      guardExport?.();
      const { ids, selectedSection, content: initial } = latest.current;
      let content = initial;
      const exportIds = exportScopeIds(content, ids, scope);
      if (exportIds && !exportIds.length) throw new Error('Select objects or a Section first');
      let exported = exportedNodes(content, exportIds);
      if (exported.some((n) => n.reference)) {
        exported = await captureReferences(content, exported);
        const captured = new Map(exported.map((n) => [n.id, n]));
        content = { ...content, nodes: content.nodes.map((n) => captured.get(n.id) ?? n) };
      }
      const box = boardBounds(content, exportIds);
      if (format === 'png' && (box.width + 60) * (box.height + 60) > 32_000_000)
        throw new Error('This board is too large for a full-size PNG. Export a Section or SVG.');
      await exportPages(
        [
          {
            name: scope === 'section' ? (selectedSection?.title ?? 'section') : 'whiteboard',
            svg: exportBoardSvg(content, exportIds),
            width: box.width + 60,
            height: box.height + 60,
          },
        ],
        format,
        1,
        'whiteboard',
        referenceExportManifest(exported),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
}

function exportScopeIds(content: WhiteboardContent, ids: string[], scope: string) {
  if (scope === 'all') return undefined;
  if (scope === 'section') return ids.filter((id) => content.sections?.some((s) => s.id === id));
  return ids;
}
/** Visible nodes in export scope, in document order. */
function exportedNodes(content: WhiteboardContent, exportIds: string[] | undefined) {
  const included = exportIds && boardSelection(content, exportIds);
  const visible = new Set(
    whiteboardPaintOrder(content)
      .filter((n) => !n.hidden)
      .map((n) => n.id),
  );
  return content.nodes.filter((n) => (!included || included.has(n.id)) && visible.has(n.id));
}
