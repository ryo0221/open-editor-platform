import type { DesignWebSettings } from '@editor-platform/design/web-contract';
import {
  referenceEnvironment,
  referenceComponents,
  referenceDependencyEnvironment,
  referenceDependencyComponent,
} from './catalog';
/** Reference Host registration only. No product code or inferred HTML roles. */
export const referenceDesignSettings: DesignWebSettings = {
  schemaVersion: 1,
  environment: referenceEnvironment,
  registrations: referenceComponents,
  inputs: {},
  callbacks: {},
  fixture: {},
  breakpoints: [{ id: 'desktop', minWidth: 800 }],
  pages: [],
};
export const referenceDependencyDesignSettings: DesignWebSettings = {
  ...referenceDesignSettings,
  environment: referenceDependencyEnvironment,
  registrations: [...referenceComponents, referenceDependencyComponent],
};

import {
  sealReactComponent,
  reactComponentKey,
  type RegisteredReactComponent,
  type ReactRuntimeAdapter,
  type ReactRuntimeResolution,
} from '@editor-platform/react-ui-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { referenceRuntimeAdapter, referenceResolution } from './catalog';
import type { DesignContent } from '@editor-platform/design/model';
import type { DesignReactConversion } from '@editor-platform/design-react-core';
/** Explicit reference Host contract edition; original TSX and old registration stay immutable. */
export function reviewedNativeCard(componentIds: string[]): RegisteredReactComponent {
  const original = referenceComponents.find((c) => c.name === 'Card')!;
  const kinds = [...new Set(componentIds)]
    .sort()
    .map((componentId) => ({ registryId: 'native-design', componentId }));
  return sealReactComponent({
    ...original,
    ref: {
      registryId: original.ref.registryId,
      componentId: original.ref.componentId,
      version: 'design-' + reuseHash(kinds).slice(0, 12),
      implementationHash: original.ref.implementationHash,
    },
    slots: Object.fromEntries(
      Object.entries(original.slots).map(([key, slot]) => [
        key,
        { ...slot, accepts: [...slot.accepts, ...kinds] },
      ]),
    ),
  });
}
export function referenceDesignRegistrations(content: DesignContent): RegisteredReactComponent[] {
  const ids = content.components.filter((c) => c.web).map((c) => c.id);
  const base = ids.length
    ? [...referenceComponents.filter((c) => c.name !== 'Card'), reviewedNativeCard(ids)]
    : referenceComponents;
  return content.web?.environment.ref.id === referenceDependencyEnvironment.ref.id
    ? [...base, referenceDependencyComponent]
    : base;
}
export function referenceDesignRuntime(content: DesignContent): ReactRuntimeAdapter {
  const reviewed = reviewedCardRegistrations(
    content.web?.registrations ?? [],
    content.components.filter((c) => c.web).map((c) => c.id),
  );
  return {
    ...referenceRuntimeAdapter,
    previewEndpoint(environment) {
      const endpoint = referenceRuntimeAdapter.previewEndpoint(environment);
      const url = new URL(endpoint.url);
      url.pathname = '/design.html';
      return { ...endpoint, url: url.href };
    },
    async resolve(request) {
      const extra = reviewed.filter((c) => c.ref.version.startsWith('design-'));
      const resolved = await referenceRuntimeAdapter.resolve({
        ...request,
        components: request.components.filter(
          (ref) => !extra.some((c) => reuseHash(c.ref) === reuseHash(ref)),
        ),
      });
      return resolved.resolution
        ? {
            ...resolved,
            resolution: {
              ...resolved.resolution,
              components: [...resolved.resolution.components, ...extra.map((c) => c.ref)],
            },
          }
        : resolved;
    },
  };
}
export function referenceDesignOriginalResolution(
  conversions: DesignReactConversion[],
  resolution: ReactRuntimeResolution = referenceResolution,
): ReactRuntimeResolution {
  const retained = conversions
    .flatMap((c) => [c.document, ...c.components.flatMap((p) => Object.values(p.documents))])
    .flatMap((d) => d.components)
    .filter((c) => c.ref.registryId === 'reference' && c.ref.version.startsWith('design-'));
  const reviewed = conversions.flatMap((c) =>
    reviewedCardRegistrations(retained, c.publishedComponentIds),
  );
  if (retained.some((c) => !reviewed.some((expected) => reuseHash(expected) === reuseHash(c))))
    throw new Error('Native slot registration was not reviewed by this Host');
  return { ...resolution, components: [...resolution.components, ...reviewed.map((c) => c.ref)] };
}
export function referenceReviewedCardFunctions(
  conversions: DesignReactConversion[],
  Card: import('react').ComponentType<Record<string, unknown>>,
) {
  return Object.fromEntries(
    conversions.flatMap((c) =>
      reviewedCardRegistrations(
        [c.document, ...c.components.flatMap((p) => Object.values(p.documents))].flatMap(
          (d) => d.components,
        ),
        c.publishedComponentIds,
      ).map((registration) => [reactComponentKey(registration.ref), Card]),
    ),
  );
}
/** Reconstruct every retained edition from the same reviewed Host rule, never trust its props. */
function reviewedCardRegistrations(retained: RegisteredReactComponent[], ids: string[]) {
  const registrations = [reviewedNativeCard(ids)];
  for (const candidate of retained) {
    if (candidate.ref.registryId !== 'reference' || !candidate.ref.version.startsWith('design-'))
      continue;
    const nativeIds =
      candidate.slots.body?.accepts
        .filter((kind) => kind.registryId === 'native-design')
        .map((kind) => kind.componentId) ?? [];
    const expected = reviewedNativeCard(nativeIds);
    if (reuseHash(candidate) === reuseHash(expected)) registrations.push(expected);
  }
  return [...new Map(registrations.map((c) => [reactComponentKey(c.ref), c])).values()];
}
