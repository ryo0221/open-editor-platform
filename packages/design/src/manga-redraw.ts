import { descendantIds, type Bounds } from '@editor-platform/editor-core';
import type { DesignContent } from './model';
import { isMangaBalloon, isMangaKeepOut } from './manga-balloons';
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
  return proposal;
}
