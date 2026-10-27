import { useRef } from 'react';
import { type GraphProfile } from './profile';
import { graphShapePath } from './shape';

/**
 * Node types as a palette, grouped by the Profile's `ui.group` (a use or a layer) in Profile
 * order; shown only when the Profile groups its types. Each entry shows the type's default shape and paint and adds one node of that type;
 * with a Section selected, the node is added inside it in the same edit.
 */
export function GraphNodePalette({
  profile,
  into,
  onAdd,
}: {
  profile: GraphProfile;
  /** The selected Section's name, when new nodes go inside it. */
  into?: string;
  onAdd: (type: string) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const groups = new Map<string, [string, GraphProfile['nodes'][string]][]>();
  for (const entry of Object.entries(profile.nodes)) {
    if (entry[1].readOnly) continue;
    const group = entry[1].ui?.group ?? 'Other';
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  // Without groups the Node type menu already lists every type.
  if (!Object.values(profile.nodes).some((t) => t.ui?.group)) return null;
  return (
    <details className="ep-graph-palette" ref={menu}>
      <summary>Palette</summary>
      <div role="group" aria-label="Node palette">
        {into && <p className="ep-graph-palette-target">Adds inside “{into}”</p>}
        {[...groups].map(([group, types]) => (
          <section key={group} aria-label={group}>
            <h4>{group}</h4>
            {types.map(([key, t]) => {
              const label = t.ui?.label ?? key,
                fill = t.ui?.style?.fill ?? '#ffffff',
                box = { x: 1, y: 1, width: 34, height: 22 };
              return (
                <button
                  key={key}
                  aria-label={`Add ${label}`}
                  onClick={() => {
                    // Close first: adding moves focus to the new node.
                    if (menu.current) menu.current.open = false;
                    onAdd(key);
                  }}
                >
                  <svg viewBox="0 0 36 24" width="36" height="24" aria-hidden="true">
                    <path
                      d={graphShapePath(t.ui?.shape ?? 'rectangle', box)}
                      fill={fill}
                      stroke={t.ui?.style?.stroke ?? '#5269c8'}
                    />
                  </svg>
                  <span>{label}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </details>
  );
}
