import { expect, it } from 'vitest';
import { fitCanvasView, wheelCanvasView } from './stage-model';

it('fits large world extents with an explicit camera range while retaining ordinary defaults', () => {
  const view = {
    zoom: 1,
    pan: { x: 0, y: 0 },
    fit: false,
    panMode: false,
    snap: false,
    grid: false,
  };
  const size = { width: 800, height: 600 };
  const bounds = { x: -1e12, y: 0, width: 2e12, height: 1 };
  const fitted = fitCanvasView(view, size, bounds, 'infinite', 1e-12);
  expect(fitted.zoom).toBeLessThan(0.001);
  expect(fitted.pan.x + bounds.x * fitted.zoom).toBeCloseTo(24);
  expect(fitted.pan.x + (bounds.x + bounds.width) * fitted.zoom).toBeCloseTo(776);
  expect(fitCanvasView(view, size, bounds, 'infinite').zoom).toBe(0.001);
  expect(fitCanvasView(view, size, bounds, 'page').zoom).toBe(0.05);
  const event = {
    ctrlKey: true,
    metaKey: false,
    deltaX: 0,
    deltaY: 20,
    clientX: 400,
    clientY: 300,
  };
  const next = wheelCanvasView(fitted, event, { x: 0, y: 0 }, 'infinite', 1e-12);
  expect(next.zoom).toBeLessThan(fitted.zoom);
  expect(next.zoom).toBeGreaterThan(0);
  expect(wheelCanvasView(fitted, event, { x: 0, y: 0 }, 'infinite').zoom).toBe(0.001);
});
