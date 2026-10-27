/**
 * Host-managed kernel builds. Only the Host writes a catalog: nothing in a document can add a
 * build, a URL or a substitution.
 */
export interface KernelCatalog<B extends { buildHash: string }> {
  /** Build for new documents and explicit migrations. */
  current: B;
  /** Older builds the Host still serves; their documents evaluate exactly. */
  retained?: B[];
  /** Builds withdrawn for safety: never run, even when retained or approved as a substitute. */
  revoked?: string[];
  /**
   * Approved read-only substitutions: documents of `from` may be shown by build `to` (same
   * semanticsVersion). Not a statement that the shapes are identical.
   */
  substitutes?: { from: string; to: string; semanticsVersion: number }[];
}
export type KernelResolution<B> =
  | { mode: 'exact'; build: B }
  | { mode: 'reference'; build: B; from: string }
  | { mode: 'unavailable'; code: 'kernel-build-unavailable' | 'kernel-build-revoked' };

/** Which build may evaluate a document's kernel profile, and whether only as a reference display. */
export function resolveKernelBuild<B extends { buildHash: string }>(
  catalog: KernelCatalog<B>,
  profile: { buildHash: string; semanticsVersion: number },
): KernelResolution<B> {
  const revoked = new Set(catalog.revoked ?? []);
  const builds = [catalog.current, ...(catalog.retained ?? [])].filter(
    (b) => !revoked.has(b.buildHash),
  );
  if (revoked.has(profile.buildHash)) return { mode: 'unavailable', code: 'kernel-build-revoked' };
  const exact = builds.find((b) => b.buildHash === profile.buildHash);
  if (exact) return { mode: 'exact', build: exact };
  for (const s of catalog.substitutes ?? []) {
    if (s.from !== profile.buildHash || s.semanticsVersion !== profile.semanticsVersion) continue;
    const build = builds.find((b) => b.buildHash === s.to);
    if (build) return { mode: 'reference', build, from: profile.buildHash };
  }
  return { mode: 'unavailable', code: 'kernel-build-unavailable' };
}
