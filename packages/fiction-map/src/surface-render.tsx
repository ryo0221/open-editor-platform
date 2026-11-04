import type { LabelOffset } from './label-layout';
import type { FictionMapFeature } from './model';
import { geometryPoints, featureStroke, stagePoint } from './surface-projection';

/** SVG painting uses the same CSS stroke/radius contract as pure candidate queries. */
export function FeatureShape({
  feature,
  axis,
  zoom,
  label,
  offset = { x: 0, y: 0 },
}: {
  feature: FictionMapFeature;
  axis: 'up' | 'down';
  zoom: number;
  label?: LabelOffset | null;
  offset?: { x: number; y: number };
}) {
  const ps = geometryPoints(feature.geometry).map((p) => stagePoint(p, axis)),
    color = feature.style?.color ?? '#386b80';
  const points = ps.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <g transform={`translate(${offset.x} ${offset.y})`} data-fiction-feature={feature.id}>
      {feature.geometry.type === 'point' ? (
        <circle
          cx={ps[0].x}
          cy={ps[0].y}
          r={7 / zoom}
          fill={color}
          stroke={color}
          strokeWidth={featureStroke(feature)}
          vectorEffect="non-scaling-stroke"
        />
      ) : feature.geometry.type === 'polyline' ? (
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={featureStroke(feature)}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <polygon
          points={points}
          fill={color}
          fillOpacity={0.24}
          strokeLinejoin="round"
          stroke={color}
          strokeWidth={featureStroke(feature)}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {feature.style?.label !== false && label !== null && (
        <text
          data-fiction-label={feature.id}
          transform={`translate(${ps[0].x} ${ps[0].y}) scale(${1 / zoom})`}
          x={label?.x ?? 12}
          y={label?.y ?? -12}
          fontSize={12}
          fill="#183341"
          stroke="white"
          strokeWidth={3}
          paintOrder="stroke"
          fontFamily="system-ui, sans-serif"
        >
          {feature.name}
        </text>
      )}
    </g>
  );
}
