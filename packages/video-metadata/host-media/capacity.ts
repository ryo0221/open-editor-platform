import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { ControlledSurfaceSnapshot } from '@editor-platform/extension-contract/controlled-surface';
import type { VideoContent } from '@editor-platform/video-core';
/** Host-private preflight of pinned draft.2 bounds, including publication/save wrappers.
 * Mirrors the accepted Geo Host admission pattern; no shared limit is increased. */
export function assertImportCapacity(
  snapshot: LocalReadSnapshot<VideoContent>,
  next: VideoContent,
  view: ControlledSurfaceSnapshot<VideoContent>,
) {
  if (view.state !== 'open') throw Error('VideoImportScopeClosed');
  const bounded = (value: unknown) => {
    let nodes = 0;
    const visit = (v: unknown, depth: number) => {
      if (++nodes > 4096 || depth > 24) throw Error('VideoImportControlledCapacity');
      if (v && typeof v === 'object') for (const child of Object.values(v)) visit(child, depth + 1);
    };
    visit(value, 0);
    if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
      throw Error('VideoImportControlledCapacity');
  };
  const revision = { ...snapshot.revision, sequence: snapshot.revision.sequence + 1 };
  bounded({
    ...view,
    snapshot: { ...snapshot, content: next, revision },
    lastOperation: { state: 'applied' },
  });
  // Reserve the existing save outcome envelope too. This private profile bounds
  // scope/operation/receipt fields; control characters maximize JSON escaping.
  for (const s of [...Object.values(snapshot.scope), snapshot.revision.sessionId])
    if (typeof s !== 'string' || s.length > 256) throw Error('VideoImportScopeCapacity');
  const long = '\u0000'.repeat(256),
    scope = { artifactId: long, sessionId: long, generation: long };
  const worstRevision = { kind: 'local-draft', sessionId: long, sequence: Number.MAX_SAFE_INTEGER };
  const capture = { scope, revision: worstRevision, contentHash: 'f'.repeat(64) };
  bounded({ operationId: long, capture, content: next });
  bounded({
    state: 'open',
    snapshot: { scope, revision: worstRevision, content: next },
    canEdit: true,
    canSave: true,
    saving: false,
    lastOperation: { state: 'refused', code: long, message: long },
    lastSave: {
      state: 'committed',
      operationId: long,
      capture,
      receipt: { adapterReceiptId: long, durability: 'adapter-acknowledged' },
    },
  });
}
