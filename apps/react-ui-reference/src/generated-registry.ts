import { referenceDesignRuntime, referenceDesignOriginalResolution } from './design-catalog';
import { clone } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import type { DesignContent } from '@editor-platform/design/model';
import { convertDesignToReact, exportDesignReact } from '@editor-platform/design-react-core';
import {
  reactComponentKey,
  type ReactComponentRef,
  type ReactRuntimeAdapter,
  type ReactUiDocument,
} from '@editor-platform/react-ui-core';
import { referenceRuntimeAdapter, referenceResolution } from './catalog';
/** Reference Host registration source. Immutable published snapshots, never editable Editor state. */
const storageKey = 'reference-host-native-react-registrations-v1';
function sources(): DesignContent[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? '[]');
  } catch {
    return [];
  }
}
function sourceFor(ref: ReactComponentRef): DesignContent | undefined {
  return sources().find((source) => {
    const conversion = convertDesignToReact(source);
    return (
      conversion.components.some((c) => reuseHash(c.registration.ref) === reuseHash(ref)) ||
      conversion.primitives.some((p) => reuseHash(p.registration.ref) === reuseHash(ref))
    );
  });
}
export function registerReferenceNative(source: DesignContent): ReactUiDocument {
  const conversion = convertDesignToReact(source);
  source = clone(source);
  if (source.web) delete source.web.accepted;
  if (conversion.diagnostics.length)
    throw new Error(conversion.diagnostics.map((d) => `${d.path}: ${d.message}`).join('; '));
  if (!conversion.components.length) throw new Error('Publish a native component contract first');
  const retained = sources();
  for (const next of conversion.components)
    for (const old of retained.flatMap((s) => convertDesignToReact(s).components))
      if (
        reactComponentKey(old.registration.ref) === reactComponentKey(next.registration.ref) &&
        reuseHash(old.registration.ref) !== reuseHash(next.registration.ref)
      )
        throw new Error(
          'Published native React version is immutable; increment its explicit version',
        );
  if (!retained.some((s) => reuseHash(s) === reuseHash(source)))
    localStorage.setItem(storageKey, JSON.stringify([...retained, clone(source)]));
  return clone(conversion.document);
}
function selectedSources(refs: ReactComponentRef[]): DesignContent[] {
  const wanted = refs.filter((ref) => ref.registryId === 'native-design');
  if (!wanted.length) return [];
  for (const source of sources().reverse()) {
    const conversion = convertDesignToReact(source);
    const available = [
      ...conversion.primitives.map((p) => p.registration.ref),
      ...conversion.components.map((p) => p.registration.ref),
    ];
    if (
      wanted.every((ref) => available.some((candidate) => reuseHash(candidate) === reuseHash(ref)))
    )
      return [source];
  }
  const missing = wanted.find((ref) => !sourceFor(ref));
  throw new Error(
    missing
      ? `Pinned generated native implementation unavailable: ${missing.componentId}`
      : 'This reference Host supports one native source publication per composition; combine sources before publishing',
  );
}
export const referenceRegisteredRuntimeAdapter: ReactRuntimeAdapter = {
  ...referenceRuntimeAdapter,
  previewEndpoint(environment) {
    const endpoint = referenceRuntimeAdapter.previewEndpoint(environment);
    const url = new URL(endpoint.url);
    url.pathname = '/design.html';
    return { ...endpoint, url: url.href };
  },
  serializePreview(request) {
    if (request.type !== 'render') return request;
    return {
      ...request,
      nativeSources: selectedSources(request.document.components.map((c) => c.ref)),
    };
  },
  async resolve(request) {
    try {
      const retained = selectedSources(request.components);
      if (
        retained.some(
          (source) => reuseHash(source.web!.environment.ref) !== reuseHash(request.environment),
        )
      )
        throw new Error(
          'Generated native source environment differs; explicitly regenerate and review under the requested environment',
        );
      const original = await (
        retained.length ? referenceDesignRuntime(retained[0]) : referenceRuntimeAdapter
      ).resolve({
        ...request,
        components: request.components.filter((c) => c.registryId !== 'native-design'),
      });
      if (!original.resolution) return original;
      const generated = retained.flatMap((source) => {
        const c = convertDesignToReact(source);
        return [
          ...c.primitives.map((p) => p.registration.ref),
          ...c.components.map((p) => p.registration.ref),
        ];
      });
      return {
        ...original,
        resolution: {
          ...original.resolution,
          components: [...original.resolution.components, ...generated],
        },
      };
    } catch (error) {
      return {
        diagnostics: [
          {
            code: 'native-registration-missing',
            severity: 'error',
            path: '$.components',
            message: String(error),
            recovery:
              'Retain the composition and obtain the exact published native source from Host.',
          },
        ],
      };
    }
  },
  async exportImplementations({ components, signal }) {
    if (signal.aborted) throw new Error('Export aborted');
    const files = selectedSources(components).flatMap((source) =>
      Object.entries(
        exportDesignReact(
          source,
          referenceDesignOriginalResolution([convertDesignToReact(source)], referenceResolution),
        ).files,
      )
        .filter(
          ([path]) =>
            /\.(tsx|css)$/.test(path) &&
            path !== 'Site.tsx' &&
            !source.web!.pages.some(
              (p) => path === p.symbol + '.tsx' || path === p.symbol + '.css',
            ),
        )
        .map(([path, text]) => ({ path, text, hash: reuseHash(text) })),
    );
    return { files, diagnostics: [] };
  },
};
