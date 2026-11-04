import { clone } from '@editor-platform/artifact-core';
import {
  command,
  withCommandReads,
  type Bounds,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  appearance,
  assertDesignContent,
  makeDesignElement,
  type DesignContent,
  type DesignElement,
} from './model';
import { captureDesignData } from './command-data';
import {
  materializeDivision,
  mapDivisionNode,
  validDividerLine,
  validDivisionTree,
  type DesignDividerLine,
  type DesignDivisionNode,
} from './division-geometry';
export * from './division-geometry';

export type DesignDivisionOperation =
  | { type: 'startDivision'; pageId: string; region: Bounds; root: DesignDivisionNode }
  | {
      type: 'splitPanel';
      pageId: string;
      panelId: string;
      newPanelId: string;
      dividerId: string;
      line: DesignDividerLine;
      gap: number;
      retain: 'a' | 'b';
      insert: 'before' | 'after';
    }
  | { type: 'setDivider'; pageId: string; dividerId: string; line: DesignDividerLine; gap: number }
  | { type: 'mergePanels'; pageId: string; dividerId: string; retainPanelId: string }
  | { type: 'detachDivision'; pageId: string };
const operationFields: Record<DesignDivisionOperation['type'], string[]> = {
  startDivision: ['type', 'pageId', 'region', 'root'],
  splitPanel: [
    'type',
    'pageId',
    'panelId',
    'newPanelId',
    'dividerId',
    'line',
    'gap',
    'retain',
    'insert',
  ],
  setDivider: ['type', 'pageId', 'dividerId', 'line', 'gap'],
  mergePanels: ['type', 'pageId', 'dividerId', 'retainPanelId'],
  detachDivision: ['type', 'pageId'],
};
export function parseDivisionOperation(raw: unknown): DesignDivisionOperation {
  const op = captureDesignData(raw, true) as DesignDivisionOperation;
  const keys = op && operationFields[op.type];
  if (!keys || Object.keys(op).length !== keys.length || !keys.every((k) => Object.hasOwn(op, k)))
    throw Error('Unsupported division operation');
  for (const [key, value] of Object.entries(op))
    if (
      (key.endsWith('Id') || key === 'type') &&
      (typeof value !== 'string' || !value.trim() || value.length > 4096)
    )
      throw Error('Invalid division ID');
  if (
    'line' in op &&
    (!validDividerLine(op.line) || !Number.isFinite(op.gap) || op.gap < 0 || op.gap > 1e12)
  )
    throw Error('Invalid divider line or gap');
  if (
    op.type === 'splitPanel' &&
    (!['a', 'b'].includes(op.retain) || !['before', 'after'].includes(op.insert))
  )
    throw Error('Choose retained side and reading order');
  if (op.type === 'startDivision' && !validDivisionTree({ region: op.region, root: op.root }))
    throw Error('Invalid division tree');
  return op;
}
const prepared = new WeakSet<EditorCommand<DesignContent>>();
export const isDesignDivisionCommand = (cmd: EditorCommand<unknown>) =>
  prepared.has(cmd as EditorCommand<DesignContent>);
/** All structural edits, materialized geometry and schema migration are one command. */
export function designDivisionCommand(
  raw: unknown,
  writable = () => true,
): EditorCommand<DesignContent> {
  const op = parseDivisionOperation(raw);
  const result = withCommandReads(
    command<DesignContent>('design.division', op.type, (d) => {
      if (!writable()) throw Error('Design is read only');
      assertDesignContent(d);
      const next = clone(d),
        page = next.pagination?.pages.find((p) => p.frameId === op.pageId);
      const frame = next.elements.find((e) => e.id === op.pageId);
      if (!page || !frame) throw Error('Select a registered page');
      const editable = (e: DesignElement) => {
        const a = appearance(d, e);
        if (a.locked || a.hidden) throw Error('Page or panel is locked or hidden');
      };
      editable(frame);
      next.elements.filter((e) => page.panelIds.includes(e.id)).forEach(editable);
      if (op.type === 'startDivision') {
        if (page.division) throw Error('Page is already linked');
        const geometry = materializeDivision({ region: op.region, root: op.root }, frame.bounds);
        const all = geometry.panels.map((p) => p.panelId);
        if (page.panelIds.some((id) => !all.includes(id)))
          throw Error('Starting division must retain every registered panel');
        for (const p of geometry.panels) {
          const existing = next.elements.find((e) => e.id === p.panelId);
          if (existing && !page.panelIds.includes(p.panelId))
            throw Error('Panel ID is already in use');
          if (existing) {
            const a = appearance(next, existing);
            if (
              a.panelGeometry ||
              (a.shape && a.shape !== 'rectangle') ||
              a.rotation ||
              a.flipX ||
              a.flipY ||
              a.radius ||
              (a.layout && a.layout.direction !== 'absolute')
            )
              throw Error('Existing panel cannot be approximated; start with rectangular panels');
          } else next.elements.push(newPanel(p.panelId, frame.id));
        }
        page.panelIds = [...page.panelIds, ...all.filter((id) => !page.panelIds.includes(id))];
        page.division = { region: clone(op.region), root: clone(op.root) };
        next.schemaVersion = 4;
        next.pagination!.schemaVersion = 2;
      } else {
        if (!page.division) throw Error('Start a linked page first');
        if (op.type === 'detachDivision') {
          delete page.division;
          assertDesignContent(next);
          return next;
        }
        const geometry = materializeDivision(page.division, frame.bounds);
        if (op.type === 'splitPanel') {
          if (!page.panelIds.includes(op.panelId)) throw Error('Select a panel on this page');
          if (
            next.elements.some((e) => e.id === op.newPanelId || e.id === op.dividerId) ||
            op.newPanelId === op.dividerId
          )
            throw Error('New panel/divider IDs must be unique');
          const node: DesignDivisionNode = {
            dividerId: op.dividerId,
            line: clone(op.line),
            gap: op.gap,
            a: { panelId: op.retain === 'a' ? op.panelId : op.newPanelId },
            b: { panelId: op.retain === 'b' ? op.panelId : op.newPanelId },
          };
          // Do not recurse through the replacement (which deliberately retains the old leaf).
          const split = (n: DesignDivisionNode): DesignDivisionNode =>
            'panelId' in n
              ? n.panelId === op.panelId
                ? node
                : n
              : { ...n, a: split(n.a), b: split(n.b) };
          page.division.root = split(page.division.root);
          next.elements.push(newPanel(op.newPanelId, frame.id));
          page.panelIds.splice(
            page.panelIds.indexOf(op.panelId) + (op.insert === 'after' ? 1 : 0),
            0,
            op.newPanelId,
          );
        } else if (op.type === 'setDivider') {
          if (!geometry.dividers.some((n) => n.dividerId === op.dividerId))
            throw Error('Divider was deleted');
          page.division.root = mapDivisionNode(page.division.root, (n) =>
            'dividerId' in n && n.dividerId === op.dividerId
              ? { ...n, line: clone(op.line), gap: op.gap }
              : n,
          );
        } else {
          let removed: string | undefined;
          page.division.root = mapDivisionNode(page.division.root, (n) => {
            if (!('dividerId' in n) || n.dividerId !== op.dividerId) return n;
            if (
              !('panelId' in n.a) ||
              !('panelId' in n.b) ||
              ![n.a.panelId, n.b.panelId].includes(op.retainPanelId)
            )
              throw Error('Merge requires two sibling panels and an explicit retained panel');
            removed = n.a.panelId === op.retainPanelId ? n.b.panelId : n.a.panelId;
            return { panelId: op.retainPanelId };
          });
          if (!removed) throw Error('Divider was deleted');
          next.elements = next.elements
            .filter((e) => e.id !== removed)
            .map((e) => (e.parentId === removed ? { ...e, parentId: op.retainPanelId } : e));
          page.panelIds = page.panelIds.filter((id) => id !== removed);
        }
      }
      const geometry = materializeDivision(page.division!, frame.bounds);
      const panels = new Map(geometry.panels.map((p) => [p.panelId, p]));
      next.elements = next.elements.map((e) => {
        const p = panels.get(e.id);
        if (!p) return e;
        const result = {
          ...e,
          bounds: p.bounds,
          panelGeometry: p.panelGeometry,
          clipContent: true,
        };
        // First adoption replaces the old rectangle, never artwork or style definitions.
        delete result.shape;
        delete result.flipX;
        delete result.flipY;
        delete result.radius;
        return result;
      });
      assertDesignContent(next);
      return next;
    }),
    { content: ['*'] },
  );
  prepared.add(result);
  return result;
}
function newPanel(id: string, parentId: string): DesignElement {
  return {
    ...makeDesignElement('frame'),
    id,
    parentId,
    name: 'Panel',
    fill: '#ffffff',
    stroke: '#111111',
    strokeWidth: 2,
    clipContent: true,
  };
}
/** Pointer-only offset clamp. The valid offsets form one continuous interval:
 * fixed descendant half-planes intersect a translating half-plane monotonically.
 * Numeric commands and proposals never call this helper. */
export function clampDividerOffset(
  content: DesignContent,
  pageId: string,
  dividerId: string,
  offset: number,
) {
  const page = content.pagination?.pages.find((p) => p.frameId === pageId),
    frame = content.elements.find((e) => e.id === pageId);
  if (!page?.division || !frame || !Number.isFinite(offset))
    throw Error('Invalid boundary gesture');
  const old = materializeDivision(page.division, frame.bounds).dividers.find(
    (d) => d.dividerId === dividerId,
  );
  if (!old) throw Error('Divider was deleted');
  const make = (value: number): DesignDivisionOperation => ({
    type: 'setDivider',
    pageId,
    dividerId,
    line: { ...old.line, offset: value },
    gap: old.gap,
  });
  const preview = (value: number) => designDivisionCommand(make(value)).apply(content);
  try {
    return { content: preview(offset), operation: make(offset), limited: false, reason: '' };
  } catch (error) {
    let low = 0,
      high = 1,
      accepted = content;
    for (let i = 0; i < 40; i++) {
      const t = (low + high) / 2;
      try {
        const next = preview(old.line.offset + (offset - old.line.offset) * t);
        low = t;
        accepted = next;
      } catch {
        high = t;
      }
    }
    return {
      content: accepted,
      operation: make(old.line.offset + (offset - old.line.offset) * low),
      limited: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
