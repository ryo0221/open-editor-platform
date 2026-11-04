import { Dialog } from '@editor-platform/editor-ui';
import type { CharacterElementRef, CharacterIdDiff } from '@editor-platform/character-core';

const kindLabels: Record<CharacterElementRef['kind'], string> = {
  part: 'Part',
  bone: 'Bone',
  morph: 'Morph',
  material: 'Material',
  action: 'Action',
};

function Group({ title, items }: { title: string; items: CharacterElementRef[] }) {
  if (!items.length) return null;
  return (
    <section aria-label={title}>
      <h3>
        {title} ({items.length})
      </h3>
      <ul>
        {items.map((e) => (
          <li key={`${e.kind}:${e.id}`}>
            {kindLabels[e.kind]} <strong>{e.name}</strong> <code>{e.id}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * CH11: what a re-import does to the addressable elements, matched by ID, before it is applied.
 * Removed and changed elements are where references need a second look; nothing is rewritten.
 */
export function CharacterImportReview({
  fileName,
  diff,
  losses,
  busy,
  onApply,
  onCancel,
}: {
  fileName: string;
  diff: CharacterIdDiff;
  losses: readonly string[];
  busy: boolean;
  onApply(): void;
  onCancel(): void;
}) {
  const recheck = diff.removed.length + diff.changed.length;
  return (
    // While the import is being applied it can no longer be cancelled: every way out waits.
    <Dialog title="Review import" onClose={() => !busy && onCancel()}>
      <p>
        <strong>{fileName}</strong>: {diff.kept.length} kept, {diff.changed.length} changed,{' '}
        {diff.added.length} added, {diff.removed.length} removed.
      </p>
      {recheck > 0 && (
        <p role="note">
          References to removed or changed elements keep their IDs and are not rewritten. Check them
          after the import.
        </p>
      )}
      <Group title="Removed" items={diff.removed} />
      <Group title="Changed" items={diff.changed} />
      <Group title="Added" items={diff.added} />
      {losses.length > 0 && <p>Not kept from the file: {losses.join(', ')}</p>}
      <button type="button" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="primary" disabled={busy} onClick={onApply}>
        Apply import
      </button>
    </Dialog>
  );
}
