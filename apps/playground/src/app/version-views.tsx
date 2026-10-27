import { canonicalJson, type CompareResult } from '@editor-platform/artifact-core';
import { documentDiff, isDocument } from '@editor-platform/document';
import { dataDiff, isStructuredData } from '@editor-platform/structured-data';
import { isFile, isReview, reviewDiff } from '@editor-platform/review-surfaces';
import { isWhiteboard, whiteboardDiff } from '@editor-platform/whiteboard';
import { isDesignWithPaths, designDiff } from '@editor-platform/design';
import { isDeck, slideDiff } from '@editor-platform/slide';
import type { StoredArtifact } from '../model';

type Version = StoredArtifact['versions'][number];

function fileOrJson(content: unknown) {
  return isFile(content)
    ? `${content.name}: ${content.mime} (${content.size} bytes)`
    : canonicalJson(content);
}

/** A domain diff that applies only when both versions are that domain's content. */
function domainDiff<T>(
  is: (content: unknown) => content is T,
  diff: (a: T, b: T) => CompareResult,
) {
  return (a: unknown, b: unknown) => (is(a) && is(b) ? diff(a, b) : undefined);
}
const domainDiffs = [
  domainDiff(isDocument, documentDiff),
  domainDiff(isStructuredData, dataDiff),
  domainDiff(isReview, reviewDiff),
  domainDiff(isWhiteboard, whiteboardDiff),
  domainDiff(isDesignWithPaths, designDiff),
  domainDiff(isDeck, slideDiff),
];

/** Domain diff of two saved versions; an empty selection falls back to the last two. */
export function compareVersions(
  active: StoredArtifact | undefined,
  beforeId: string,
  afterId: string,
): CompareResult {
  if (!active) return { changes: [] };
  const a = active.versions.find((v) => v.versionId === beforeId) ?? active.versions.at(-2);
  const b = active.versions.find((v) => v.versionId === afterId) ?? active.versions.at(-1);
  if (!a || !b) return { changes: [] };
  for (const diff of domainDiffs) {
    const result = diff(a.content, b.content);
    if (result) return result;
  }
  return {
    changes:
      canonicalJson(a.content) === canonicalJson(b.content)
        ? []
        : [
            {
              elementId: active.id,
              path: 'content',
              kind: 'changed',
              before: fileOrJson(a.content),
              after: fileOrJson(b.content),
            },
          ],
  };
}

export function HistoryView({
  versions,
  onRestore,
}: {
  versions: Version[];
  onRestore(version: Version): void;
}) {
  return (
    <section className="history-view">
      <h2>Version history</h2>
      <p className="muted">
        Committed snapshots are immutable. Editing continues in a separate draft.
      </p>
      {versions.length === 0 ? (
        <p className="empty">Save your first version to begin a history.</p>
      ) : (
        versions.map((v, i) => (
          <article key={v.versionId}>
            <span className="version-number">{i + 1}</span>
            <div>
              <h3>{v.reason ?? 'Saved version'}</h3>
              <p>
                {new Date(v.createdAt).toLocaleString()} · {v.createdBy}
              </p>
              <code title={v.contentHash}>SHA-256 {v.contentHash.slice(0, 16)}…</code>
            </div>
            <button onClick={() => onRestore(v)}>Restore to draft</button>
          </article>
        ))
      )}
    </section>
  );
}

function VersionSelect({
  label,
  versions,
  value,
  onChange,
}: {
  label: 'Before' | 'After';
  versions: Version[];
  value: string;
  onChange(id: string): void;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={`${label} version`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {versions.map((v, i) => (
          <option key={v.versionId} value={v.versionId}>
            Version {i + 1} · {v.reason}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CompareView({
  versions,
  beforeId,
  afterId,
  onBeforeChange,
  onAfterChange,
  compare,
}: {
  versions: Version[];
  beforeId: string;
  afterId: string;
  onBeforeChange(id: string): void;
  onAfterChange(id: string): void;
  compare(): CompareResult;
}) {
  if (versions.length < 2)
    return (
      <section className="compare-view">
        <h2>Compare versions</h2>
        <p className="empty">Save at least two versions to compare their content.</p>
      </section>
    );
  const { changes } = compare();
  return (
    <section className="compare-view">
      <h2>Compare versions</h2>
      <div className="compare-controls">
        <VersionSelect
          label="Before"
          versions={versions}
          value={beforeId || versions.at(-2)!.versionId}
          onChange={onBeforeChange}
        />
        <span>→</span>
        <VersionSelect
          label="After"
          versions={versions}
          value={afterId || versions.at(-1)!.versionId}
          onChange={onAfterChange}
        />
      </div>
      <p>{changes.length} changes</p>
      {changes.map((change, i) => (
        <article className={`change ${change.kind}`} key={i}>
          <header>
            <strong>{change.kind}</strong>
            <span>{change.path}</span>
          </header>
          <div className="text-pair">
            <pre>{change.before ?? '—'}</pre>
            <pre>{change.after ?? '—'}</pre>
          </div>
        </article>
      ))}
      {changes.length === 0 && <p className="empty">These versions have identical content.</p>}
    </section>
  );
}
