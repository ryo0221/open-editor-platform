import { reuseHash } from '@editor-platform/reuse-core';
import { reactComponentKey, type ReactRuntimeAdapter } from '@editor-platform/react-ui-core';
import { scaleComponents, scaleEnvironment, scaleResolution, scaleSource } from './catalog';

export function attestScaleBytes() {
  const hashes = [
    reuseHash(scaleSource.implementation),
    reuseHash(scaleSource.css),
    reuseHash(scaleSource.image),
  ];
  const expected = scaleEnvironment.dependencies
    .filter((d) => d.kind !== 'provider')
    .map((d) => d.hash);
  if (hashes.some((hash, index) => hash !== expected[index]))
    throw Error('Pinned scale bytes changed');
  return scaleResolution;
}
export const scaleRuntime: ReactRuntimeAdapter = {
  async resolve({ environment, components, signal }) {
    signal.throwIfAborted();
    const available = new Map(
      scaleComponents.map((c) => [reactComponentKey(c.ref), reuseHash(c.ref)]),
    );
    if (
      reuseHash(environment) !== reuseHash(scaleEnvironment.ref) ||
      components.some((c) => available.get(reactComponentKey(c)) !== reuseHash(c))
    )
      throw Error('Unresolved exact scale runtime');
    return { resolution: attestScaleBytes(), diagnostics: [] };
  },
  previewEndpoint(environment) {
    const url = new URL('http://127.0.0.1:4195/preview.html');
    url.searchParams.set('parentOrigin', location.origin);
    return { url: url.href, environment };
  },
  async exportDependencies() {
    attestScaleBytes();
    const asset = Uint8Array.from(atob(scaleSource.image.split(',')[1]), (c) => c.charCodeAt(0));
    return {
      diagnostics: [],
      files: [
        {
          dependencyId: 'scale-css',
          path: 'styles/scale.css',
          hash: reuseHash(scaleSource.css),
          bytes: new TextEncoder().encode(scaleSource.css),
        },
        {
          dependencyId: 'scale-image',
          path: 'assets/scale.png',
          hash: reuseHash(scaleSource.image),
          bytes: asset,
        },
      ],
    };
  },
};
