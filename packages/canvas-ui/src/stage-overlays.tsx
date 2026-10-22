import type React from 'react';
import type { Bounds, Point } from '@editor-platform/editor-core';
import type { CanvasTarget } from './index';
import { handleAnchor, selectionHandles, type SnapGuide } from './stage-model';

export function CanvasGrid({ label, bounds }: { label: string; bounds: Bounds }) {
  return (
    <>
      <defs>
        <pattern
          id={`${label.replaceAll(' ', '')}-dots`}
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".6" fill="#ccd2dc" />
        </pattern>
      </defs>
      <rect {...bounds} fill={`url(#${label.replaceAll(' ', '')}-dots)`} />
    </>
  );
}

export function PresenceMarkers(props: {
  presences: { elementId: string; name: string; clientId: string }[];
  targets: CanvasTarget[];
  zoom: number;
}) {
  const { zoom } = props;
  return props.presences.map((presence) => {
    const target = props.targets.find((t) => t.id === presence.elementId);
    return target ? (
      <g key={presence.clientId} pointerEvents="none" data-presence={presence.name}>
        <rect
          {...target.bounds}
          fill="none"
          stroke="#8b5cf6"
          strokeWidth={2 / zoom}
          strokeDasharray={`${4 / zoom} ${3 / zoom}`}
        />
        <text
          x={target.bounds.x}
          y={target.bounds.y - 5 / zoom}
          fill="#6d28d9"
          fontSize={12 / zoom}
        >
          {presence.name}
        </text>
      </g>
    ) : null;
  });
}

export function SelectionOverlay(props: {
  box: Bounds;
  rotation: number;
  zoom: number;
  selected: string[];
  targets: CanvasTarget[];
  onBegin(e: React.PointerEvent, mode: 'resize' | 'rotate', handle?: string): void;
}) {
  const { box, zoom, selected, targets } = props;
  return (
    <g
      className="selection-overlay"
      transform={`rotate(${props.rotation} ${box.x + box.width / 2} ${box.y + box.height / 2})`}
    >
      <rect {...box} fill="none" stroke="#3267c8" strokeWidth={1 / zoom} pointerEvents="none" />
      {selectionHandles.map((handle) => {
        const { x, y } = handleAnchor(handle, box),
          sz = 8 / zoom;
        return (
          <rect
            key={handle}
            role="button"
            aria-label={`Resize ${handle === 'se' && selected.length === 1 ? targets.find((t) => t.id === selected[0])?.label : handle}`}
            x={x - sz / 2}
            y={y - sz / 2}
            width={sz}
            height={sz}
            fill="white"
            stroke="#3267c8"
            strokeWidth={1 / zoom}
            style={{ cursor: `${handle}-resize` }}
            onPointerDown={(e) => props.onBegin(e, 'resize', handle)}
          />
        );
      })}
      {selected.every((id) => targets.find((t) => t.id === id)?.rotatable !== false) && (
        <>
          <line
            x1={box.x + box.width / 2}
            x2={box.x + box.width / 2}
            y1={box.y}
            y2={box.y - 24 / zoom}
            stroke="#3267c8"
            strokeWidth={1 / zoom}
            pointerEvents="none"
          />
          <circle
            role="button"
            aria-label="Rotate selection"
            cx={box.x + box.width / 2}
            cy={box.y - 26 / zoom}
            r={5 / zoom}
            fill="white"
            stroke="#3267c8"
            strokeWidth={1 / zoom}
            onPointerDown={(e) => props.onBegin(e, 'rotate')}
          />
        </>
      )}
    </g>
  );
}

export function SnapGuides({ guides, zoom }: { guides: SnapGuide[]; zoom: number }) {
  return guides.map((g, i) => (
    <line
      key={i}
      x1={g.axis === 'x' ? g.value : -10000}
      x2={g.axis === 'x' ? g.value : 10000}
      y1={g.axis === 'y' ? g.value : -10000}
      y2={g.axis === 'y' ? g.value : 10000}
      stroke="#d45092"
      strokeWidth={1 / zoom}
      pointerEvents="none"
    />
  ));
}

export function FreehandPath({ path }: { path: Point[] }) {
  return (
    <path
      d={path.map((v, i) => `${i ? 'L' : 'M'}${v.x} ${v.y}`).join(' ')}
      fill="none"
      stroke="#3267c8"
      strokeWidth={3}
    />
  );
}
