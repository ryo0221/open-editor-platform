import { useEffect, useState } from 'react';
import { initialCanvasView, type CanvasView } from '@editor-platform/canvas-ui';

const cameraKey = (viewKey: string | undefined) => `ep-camera:${viewKey ?? 'whiteboard'}`;

function validSavedView(saved: Partial<CanvasView> | null): saved is Partial<CanvasView> {
  return (
    !!saved &&
    Number.isFinite(saved.pan?.x) &&
    Number.isFinite(saved.pan?.y) &&
    saved.zoom! >= 0.001 &&
    saved.zoom! <= 8
  );
}
/** Restores the per-view camera preference; invalid or unreadable values fall back. */
function readSavedView(viewKey: string | undefined): CanvasView {
  try {
    const saved = JSON.parse(localStorage.getItem(cameraKey(viewKey)) ?? 'null');
    if (validSavedView(saved)) return { ...initialCanvasView, ...saved };
  } catch {
    /* view preference only */
  }
  return { ...initialCanvasView, fit: false };
}
function saveView(viewKey: string | undefined, view: CanvasView) {
  try {
    localStorage.setItem(cameraKey(viewKey), JSON.stringify(view));
  } catch {
    /* view preference only */
  }
}

/** Camera state persisted per view key. */
export function useSavedView(viewKey: string | undefined) {
  const [view, setView] = useState<CanvasView>(() => readSavedView(viewKey));
  useEffect(() => saveView(viewKey, view), [view, viewKey]);
  return [view, setView] as const;
}
