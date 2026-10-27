import type { Drawing } from './drawing';
/** Short display fingerprint, not an integrity/security hash. Avoid dumping embedded image bytes. */
export function displayFingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
/** Bounded comparison text; the fingerprint is for display, never content integrity. */
export function describeVector(vector: NonNullable<Drawing['vector']>): string {
  const { viewBox: box, paths, provenance: source } = vector;
  const geometry = displayFingerprint(
    JSON.stringify({ viewBox: [box.x, box.y, box.width, box.height], paths }),
  );
  return `Vector: ${source.name.slice(0, 256)} · source ${source.source.slice(0, 256)} · version ${source.version.slice(0, 256)} · license ${source.license.slice(0, 256)}\nVector geometry: ${geometry} · ${paths.length} paths`;
}
export function describeDrawing(d: Drawing): string {
  const b = d.bounds,
    lines = [
      `${d.kind}${d.kind === 'shape' && (d.path || d.vector || d.shape) ? `: ${d.path ? 'path' : d.vector ? 'vector' : d.shape}` : ''}`,
      `Position: ${b.x}, ${b.y} px · Size: ${b.width} × ${b.height} px · Rotation: ${d.rotation ?? 0}°`,
      `Fill: ${d.fill} · Stroke: ${d.stroke ?? 'default'} / ${d.strokeWidth ?? 1} px · Opacity: ${Math.round((d.opacity ?? 1) * 100)}%`,
      `Visibility: ${d.hidden ? 'hidden' : 'visible'} · ${d.locked ? 'locked' : 'unlocked'}`,
      `Corner radius: ${d.radius ?? 0} · Dash: ${d.dash || 'solid'} · Arrowhead: ${d.arrowhead ?? 'none'}`,
    ];
  if (d.text) lines.push(`Text: ${d.text}`);
  if (d.typography)
    lines.push(
      `Typography: ${Object.entries(d.typography)
        .map(([key, value]) => `${key} = ${value}`)
        .join(', ')}`,
    );
  if (d.runs?.length)
    lines.push(
      ...d.runs.map(
        (run) =>
          `“${run.text}”: ${
            Object.entries(run.style ?? {})
              .map(([key, value]) => `${key} = ${value}`)
              .join(', ') || 'default formatting'
          }`,
      ),
    );
  if (d.src)
    lines.push(
      `Image: ${d.alt ?? 'untitled'} · content ${displayFingerprint(d.src)} · ${d.imageFit ?? 'fit'}`,
    );
  if (d.path)
    lines.push(
      `Structured path (${d.path.fillRule}) · geometry ${displayFingerprint(JSON.stringify(d.path))}`,
    );
  if (d.vector) lines.push(describeVector(d.vector));
  if (d.crop) lines.push(`Crop: ${d.crop.x}, ${d.crop.y}; scale ${d.crop.scale}`);
  if (d.flipX || d.flipY)
    lines.push(`Flip: ${d.flipX ? 'horizontal' : ''} ${d.flipY ? 'vertical' : ''}`);
  if (d.table)
    lines.push(
      'Table:',
      ...d.table.rows.map((row) => row.join(' | ')),
      `Merged cells: ${d.table.merges?.map((m) => `${m.row + 1}:${m.col + 1} (${m.rows}×${m.cols})`).join(', ') || 'none'}`,
      `Column widths: ${d.table.columnWidths?.join(', ') ?? 'equal'}; row heights: ${d.table.rowHeights?.join(', ') ?? 'equal'}`,
    );
  if (d.chart)
    lines.push(
      `Chart: ${d.chart.label ?? ''} (${d.chart.type ?? 'bar'})`,
      ...d.chart.labels.map((label, i) => `${label}: ${d.chart!.values[i]}`),
    );
  return lines.join('\n');
}
