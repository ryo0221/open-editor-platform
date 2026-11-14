import { useState } from 'react';
import { fictionMapLimits } from './limits';
import {
  updateFeatureMetadata,
  type FictionMapArtifactRef,
  type FictionMapBase,
  type FictionMapChange,
  type FictionMapFeature,
  type FictionMapResult,
} from './model';

/** How the Host sees one pinned version right now. The map never follows the latest version. */
export type FictionMapArtifactRefStatus =
  | 'ready'
  | 'missing-source'
  | 'missing-version'
  | 'hash-mismatch'
  | 'wrong-domain';
export interface FictionMapArtifactRefOption {
  readonly label: string;
  /** The Artifact's latest committed version, which pinning fixes. */
  readonly ref: FictionMapArtifactRef;
}
/**
 * GV2a optional Host service. The Host owns the Artifacts and versions; the map stores only
 * the pinned pointer (Artifact, version ID, content hash).
 */
export interface FictionMapArtifactRefHost {
  options(): readonly FictionMapArtifactRefOption[];
  status(ref: FictionMapArtifactRef): FictionMapArtifactRefStatus;
  open(ref: FictionMapArtifactRef): void;
}
const statusText: Record<FictionMapArtifactRefStatus, string> = {
  ready: 'Pinned version available',
  'missing-source': 'Artifact not found',
  'missing-version': 'Pinned version not found',
  'hash-mismatch': 'Pinned version content differs',
  'wrong-domain': 'Artifact kind changed',
};

/**
 * A Host name as an optional pin label: controls become spaces, ends are trimmed, and it is cut
 * to 128 UTF-16 units without splitting a surrogate pair; lone surrogates are dropped. Nothing
 * left means no label.
 */
export function pinLabel(name: string): string | undefined {
  let t = '';
  const spaced = Array.from(name, (ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('');
  for (const ch of spaced.trim()) {
    // A lone surrogate is not text the map admits; drop it.
    if (ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff) continue;
    if (t.length + ch.length > 128) break;
    t += ch;
  }
  t = t.trim();
  return t || undefined;
}

export function refLabel(ref: FictionMapArtifactRef): string {
  return ref.label ?? `${ref.domain} ${ref.artifactId}`;
}

/** Pin, list, open and unpin 3D versions on one feature. Each change is one map command. */
export function FeatureArtifactRefs({
  base,
  feature,
  host,
  disabled,
  canChange,
  apply,
}: {
  base: FictionMapBase;
  feature: FictionMapFeature;
  host?: FictionMapArtifactRefHost;
  disabled: boolean;
  /** False (after reporting why) while other feature input is pending. */
  canChange?(): boolean;
  apply(base: FictionMapBase, result: FictionMapResult<FictionMapChange>): boolean;
}) {
  const refs = feature.artifactRefs ?? [];
  const options = host
    ? host.options().filter((o) => !refs.some((r) => r.artifactId === o.ref.artifactId))
    : [];
  const [choice, setChoice] = useState('');
  const picked = options.find((o) => o.ref.artifactId === choice) ?? options[0];
  if (!host && !refs.length) return null;
  function commit(next: readonly FictionMapArtifactRef[]) {
    if (canChange && !canChange()) return;
    apply(
      base,
      updateFeatureMetadata(
        base.content,
        feature.id,
        next.length ? { set: { artifactRefs: next } } : { clear: ['artifactRefs'] },
      ),
    );
  }
  return (
    <section className="fm-artifact-refs" aria-label="Pinned 3D versions">
      <h3>3D versions</h3>
      {!host && <p>Artifact service is not connected. Pinned versions stay as native data.</p>}
      {refs.length > 0 && (
        <ul>
          {refs.map((ref) => {
            const status = host?.status(ref);
            return (
              <li key={ref.artifactId} data-artifact-ref={ref.artifactId} data-status={status}>
                <span>{refLabel(ref)}</span>{' '}
                <code title={ref.contentHash}>{ref.contentHash.slice(0, 12)}</code>
                {status && <span className="fm-ref-status"> · {statusText[status]}</span>}{' '}
                {host && (
                  <button
                    type="button"
                    disabled={status !== 'ready'}
                    onClick={() => host.open(ref)}
                  >
                    Open {refLabel(ref)}
                  </button>
                )}{' '}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => commit(refs.filter((r) => r.artifactId !== ref.artifactId))}
                >
                  Unpin {refLabel(ref)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {host &&
        (options.length ? (
          <div className="fm-ref-pin">
            <select
              aria-label="Artifact to pin"
              value={picked?.ref.artifactId ?? ''}
              disabled={disabled}
              onChange={(e) => setChoice(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.ref.artifactId} value={o.ref.artifactId}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={
                disabled || !picked || refs.length >= fictionMapLimits.artifactRefsPerFeature
              }
              onClick={() => picked && commit([...refs, picked.ref])}
            >
              Pin latest version
            </button>
          </div>
        ) : (
          <p>No other saved versions to pin.</p>
        ))}
    </section>
  );
}
