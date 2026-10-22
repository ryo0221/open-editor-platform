import { type ContextType, type KeyboardEvent } from 'react';
import { EditorHistoryContext, isTextInput } from '@editor-platform/editor-ui';
import { type Column, type DataRow } from './model';
import { type CellAddress } from './grid-model';

export interface GridKeyContext {
  editing: boolean;
  history: ContextType<typeof EditorHistoryContext>;
  readOnly: boolean;
  rows: DataRow[];
  columns: Column[];
  at: CellAddress | null;
  ri: number;
  ci: number;
  rowAnchor: string | undefined;
  onError: (error: string) => void;
  onActive: (address: CellAddress) => void;
  setRowAnchor: (id: string | undefined) => void;
  setAnchor: (address: CellAddress | null) => void;
  setContext: (context: null) => void;
  choose: (r: number, c: number, extend?: boolean) => void;
  edit: (initial?: string) => void;
  fill: () => void;
  clear: () => void;
  deleteSelectedRows: () => void;
}
type GridKeyEvent = KeyboardEvent<HTMLDivElement>;

function historyKey(e: GridKeyEvent, k: GridKeyContext) {
  const history = k.history;
  if (
    !history ||
    k.readOnly ||
    !(e.ctrlKey || e.metaKey) ||
    e.altKey ||
    !['z', 'y'].includes(e.key.toLowerCase())
  )
    return false;
  e.preventDefault();
  e.stopPropagation();
  try {
    if (e.shiftKey || e.key.toLowerCase() === 'y') history.redo();
    else history.undo();
  } catch (error) {
    k.onError((error as Error).message);
  }
  return true;
}

function selectionKey(e: GridKeyEvent, k: GridKeyContext) {
  if (e.key === 'Escape') {
    k.setRowAnchor(undefined);
    k.setContext(null);
    k.setAnchor(k.at);
    return true;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    k.setRowAnchor(undefined);
    if (k.rows.length && k.columns.length) {
      k.setAnchor({ rowId: k.rows[0].id, columnId: k.columns[0].id });
      k.onActive({ rowId: k.rows.at(-1)!.id, columnId: k.columns.at(-1)!.id });
    }
    return true;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    k.fill();
    return true;
  }
  return false;
}

function moveKey(e: GridKeyEvent, k: GridKeyContext) {
  const moves: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
    Tab: [0, e.shiftKey ? -1 : 1],
  };
  if (!moves[e.key]) return false;
  e.preventDefault();
  let r = k.ri + moves[e.key][0],
    c = k.ci + moves[e.key][1];
  if (e.key === 'Tab') {
    if (c >= k.columns.length) {
      r++;
      c = 0;
    }
    if (c < 0) {
      r--;
      c = k.columns.length - 1;
    }
  }
  k.choose(
    Math.max(0, Math.min(k.rows.length - 1, r)),
    Math.max(0, Math.min(k.columns.length - 1, c)),
    e.shiftKey && e.key !== 'Tab',
  );
  return true;
}

function editKey(e: GridKeyEvent, k: GridKeyContext) {
  if (['Enter', 'F2'].includes(e.key)) {
    e.preventDefault();
    k.edit();
    return;
  }
  if (['Delete', 'Backspace'].includes(e.key)) {
    e.preventDefault();
    if (k.rowAnchor && !k.readOnly) {
      k.deleteSelectedRows();
      k.setRowAnchor(undefined);
    } else k.clear();
    return;
  }
  if (
    !k.readOnly &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.nativeEvent.isComposing &&
    e.key.length === 1
  ) {
    e.preventDefault();
    k.edit(e.key);
  }
}

export function handleGridKeyDown(e: GridKeyEvent, k: GridKeyContext) {
  if (k.editing || isTextInput(e.target) || e.nativeEvent.isComposing) return;
  if (historyKey(e, k) || selectionKey(e, k) || moveKey(e, k)) return;
  editKey(e, k);
}
