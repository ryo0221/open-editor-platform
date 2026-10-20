import type { DesignContent } from '@editor-platform/design/model';
import type { ReactRuntimeAdapter } from '@editor-platform/react-ui-core';
import { convertDesignToReact, exportDesignReact } from '@editor-platform/design-react-core';

/** Resolves the pinned runtime, exports the bundle and collects pinned CSS/asset bytes. */
export async function prepareDesignReactBundle(
  source: DesignContent,
  runtime: ReactRuntimeAdapter,
  svg: boolean,
  rootIds: string[] | undefined,
) {
  const resolved = await runtime.resolve({
    environment: source.web!.environment.ref,
    components: source.web!.registrations.map((c) => c.ref),
    signal: new AbortController().signal,
  });
  if (!resolved.resolution || resolved.diagnostics.length)
    throw new Error(resolved.diagnostics.map((d) => d.message).join('; '));
  const output = exportDesignReact(source, resolved.resolution, {
    mode: svg ? 'svg' : 'web',
    ...(rootIds ? { rootIds } : {}),
  });
  const dependencies = svg
    ? undefined
    : await runtime.exportDependencies?.({
        environment: source.web!.environment.ref,
        signal: new AbortController().signal,
      });
  if (dependencies?.diagnostics.length)
    throw new Error(dependencies.diagnostics.map((d) => d.message).join('; '));
  const supplied: { path: string; bytes: Uint8Array }[] = [];
  for (const dependency of svg
    ? []
    : source.web!.environment.dependencies.filter((d) => d.kind === 'css' || d.kind === 'asset')) {
    const file = dependencies?.files.find((f) => f.dependencyId === dependency.id);
    if (
      !file ||
      !('path' in dependency) ||
      file.path !== dependency.path ||
      file.hash !== dependency.hash ||
      output.files[file.path]
    )
      throw new Error('Pinned dependency bytes unavailable: ' + dependency.id);
    supplied.push({ path: file.path, bytes: file.bytes });
  }
  return { output, supplied };
}

/** Publication diagnostics for a component, including an unused definition. */
export function designReactPublicationDiagnostics(candidate: DesignContent, componentId: string) {
  if (!candidate.web) return [];
  const roots = candidate.elements
    .filter((element) => element.componentId === componentId)
    .map((element) => element.id);
  // Validate an unused definition through a temporary native instance, without saving it.
  const definition = candidate.components.find((component) => component.id === componentId)!;
  let counter = 0;
  let id = `publication-validation:${counter}`;
  while (candidate.elements.some((element) => element.id === id))
    id = `publication-validation:${++counter}`;
  return convertDesignToReact(
    roots.length
      ? candidate
      : {
          ...candidate,
          elements: [
            ...candidate.elements,
            {
              id,
              name: definition.name,
              type: 'instance',
              componentId,
              text: '',
              fill: '#ffffff',
              bounds: { x: 0, y: 0, width: definition.width, height: definition.height },
            },
          ],
        },
    roots.length ? roots : [id],
  ).diagnostics;
}
