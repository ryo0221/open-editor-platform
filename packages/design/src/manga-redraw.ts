import { descendantIds, type Bounds } from '@editor-platform/editor-core';
import type { DesignContent } from './model';
import { designPageEditCommand } from './pagination';
import { isMangaBalloon, isMangaKeepOut, mangaCoverBox } from './manga-balloons';
import type { DesignPageProposalRequest } from './page-proposals';

/**
 * #21 Redraw one panel. The request names the panel, its place in the reading order, its region
 * and what is in it; the Host (which owns AI execution) answers with an ordinary page proposal.
 * `checkPanelRedrawProposal` keeps that answer inside the panel before it reaches the review.
 */
export interface DesignPanelRedrawRequest {
  panelId: string;
  pageId: string;
  /** 1-based, in reading order. */
  page: number;
  panel: number;
  /** World bounds of the panel. */
  region: Bounds;
  notes: string;
  /** Images inside the panel, which a redraw replaces. */
  imageIds: string[];
  /** Faces and figures balloons keep off, and the balloons, so a redraw keeps the lettering readable. */
  keepOut: { id: string; bounds: Bounds }[];
  balloons: { id: string; bounds: Bounds }[];
}

export const panelRedrawNotesLimit = 4000;

export function designPanelRedrawRequest(
  d: DesignContent,
  panelId: string,
  notes: string,
): DesignPanelRedrawRequest {
  if (typeof notes !== 'string' || notes.length > panelRedrawNotesLimit)
    throw Error(`Redraw notes exceed ${panelRedrawNotesLimit} characters`);
  const pages = d.pagination?.pages ?? [];
  const pageIndex = pages.findIndex((p) => p.panelIds.includes(panelId));
  const panel = d.elements.find((e) => e.id === panelId);
  if (pageIndex < 0 || !panel) throw Error(`Panel ${panelId} is not in the reading order`);
  const inside = descendantIds(d.elements, [panelId]);
  const within = d.elements.filter((e) => e.id !== panelId && inside.has(e.id));
  return {
    panelId,
    pageId: pages[pageIndex].frameId,
    page: pageIndex + 1,
    panel: pages[pageIndex].panelIds.indexOf(panelId) + 1,
    region: { ...panel.bounds },
    notes,
    imageIds: within.filter((e) => e.type === 'image').map((e) => e.id),
    keepOut: within.filter(isMangaKeepOut).map((e) => ({ id: e.id, bounds: { ...e.bounds } })),
    balloons: within.filter(isMangaBalloon).map((e) => ({ id: e.id, bounds: { ...e.bounds } })),
  };
}

const contains = (outer: Bounds, b: Bounds) =>
  b.x >= outer.x - 1e-6 &&
  b.y >= outer.y - 1e-6 &&
  b.x + b.width <= outer.x + outer.width + 1e-6 &&
  b.y + b.height <= outer.y + outer.height + 1e-6;

/**
 * Refuse a redraw answer that reaches outside the panel: only image, text and bounds changes to
 * elements inside the panel, with bounds that stay in the panel. Page division and reading-order
 * changes belong to a whole-page proposal.
 */
export function checkPanelRedrawProposal(
  d: DesignContent,
  request: DesignPanelRedrawRequest,
  proposal: DesignPageProposalRequest,
): DesignPageProposalRequest {
  const inside = descendantIds(d.elements, [request.panelId]);
  inside.delete(request.panelId);
  for (const unit of proposal.units)
    for (const op of unit.operations) {
      if (op.type !== 'image' && op.type !== 'text' && op.type !== 'bounds')
        throw Error(`A panel redraw cannot change ${op.type}; ask for a page proposal instead`);
      if (!inside.has(op.id))
        throw Error(
          `A panel redraw can only change elements in panel ${request.panelId} (${op.id})`,
        );
      if (op.type === 'bounds' && !contains(request.region, op.value))
        throw Error(`${op.id} would move outside panel ${request.panelId}`);
    }
  // The whole answer played through; the review checks each other selection before its preview
  // (`checkPanelRedrawSelection`).
  checkPanelRedrawSelection(
    d,
    request,
    proposal,
    proposal.units.map((u) => u.id),
  );
  return proposal;
}

/**
 * The moves of the selected units, played through in the order the review applies them (each
 * unit after the ones it needs): every element inside the panel that moved, its parts included,
 * must stay in the panel as drawn. A group's move carries its parts with it, so a selection can
 * reach outside even when every bounds value is inside (Codex on #28).
 */
export function checkPanelRedrawSelection(
  d: DesignContent,
  request: DesignPanelRedrawRequest,
  proposal: DesignPageProposalRequest,
  selected: readonly string[],
) {
  const inside = descendantIds(d.elements, [request.panelId]);
  inside.delete(request.panelId);
  const units = new Map(proposal.units.map((u) => [u.id, u]));
  const order: string[] = [];
  const visit = (id: string) => {
    if (order.includes(id) || !units.has(id)) return;
    units.get(id)!.requires.forEach(visit);
    order.push(id);
  };
  proposal.units.filter((u) => selected.includes(u.id)).forEach((u) => visit(u.id));
  // Every selected change, played as the review applies it: a text change relays out the text
  // around it, so it can move or grow elements too (Codex on #28).
  let next = d;
  for (const id of order)
    for (const op of units.get(id)!.operations) {
      // Only image, text and bounds changes reach here (checkPanelRedrawProposal refuses others)
      if (op.type !== 'image' && op.type !== 'text' && op.type !== 'bounds') continue;
      if (!next.elements.some((e) => e.id === op.id)) continue;
      next = designPageEditCommand([op]).apply(next);
    }
  if (next === d) return;
  const before = new Map(d.elements.map((e) => [e.id, e]));
  for (const e of next.elements) {
    const was = before.get(e.id);
    if (!was || was === e) continue;
    const same =
      (['x', 'y', 'width', 'height'] as const).every((k) => was.bounds[k] === e.bounds[k]) &&
      (was.rotation ?? 0) === (e.rotation ?? 0);
    if (same) continue;
    // A layout around the panel (the page's row, the panel's own hug size) can carry a change
    // out of it: the panel and everything outside it must keep their place (Codex on #28).
    if (!inside.has(e.id))
      throw Error(
        `A panel redraw cannot move or resize ${e.id}, which is not inside panel ${request.panelId}`,
      );
    if (!contains(request.region, mangaCoverBox(e)))
      throw Error(`${e.id} would move outside panel ${request.panelId}`);
  }
}
