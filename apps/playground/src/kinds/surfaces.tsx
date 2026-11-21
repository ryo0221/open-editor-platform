// The Playground's Surfaces: each registered kind paired with its Host parts. App.tsx renders
// through this list and has no per-kind Surface branch (docs/kind-registry-design.md).
import { validContent, type Content } from '../model';
import { engineeringDefinitions } from './engineering';
import { engineeringSurfaces, estimateGeometry } from './engineering/surfaces';
import { ordinaryHooks, pairSurfaces, type HostKindEntry, type KindHooks } from './host-kind';
import { officeDefinitions } from './office';
import { officeSurfaces } from './office/surfaces';
import type { SurfaceHost } from './surface-host';

const surfaces = pairSurfaces(
  [...officeDefinitions, ...engineeringDefinitions],
  [...officeSurfaces({ estimateGeometry }), ...engineeringSurfaces],
);

/** Content the active Artifact's Surface renders: valid for its kind and accepted by its Surface. */
export interface RenderedContent {
  kind: string;
  content: Content;
  entry: HostKindEntry;
}

export function checkedContent(
  content: unknown,
  kind: string | undefined,
): RenderedContent | undefined {
  const entry = kind === undefined ? undefined : surfaces.get(kind);
  if (!entry || !validContent(entry.kind, content) || !entry.accepts(content)) return undefined;
  return { kind: entry.kind, content, entry };
}

/** The editor view: exactly one native surface renders for the validated content. */
export function EditorSurfaces({
  host,
  rendered,
}: {
  host: SurfaceHost;
  rendered: RenderedContent | undefined;
}) {
  return <>{rendered?.entry.render(host, rendered.content)}</>;
}

/** The Playground behaviour of a stored kind; a kind this Host does not know behaves ordinarily. */
export function kindHooks(kind: string | undefined): KindHooks {
  return (kind === undefined ? undefined : surfaces.get(kind)?.hooks) ?? ordinaryHooks;
}
