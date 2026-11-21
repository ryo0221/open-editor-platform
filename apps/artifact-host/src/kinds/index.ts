// Every kind this Artifact Host hosts, from the shared definitions plus its own Code kind. Host
// connections that need engineering code are made here, not in the office list.
import { pairKinds } from '@editor-platform/artifact-kinds';
import { loadHostArtifact, type EditorHostAdapter } from '@editor-platform/editor-host';
import type { Artifact } from '@editor-platform/artifact-core';
import type { HostContent } from '../content';
import { verifyArtifactEstimate } from '../estimate-bim';
import { engineeringDefinitions, engineeringKinds } from './engineering';
import { officeDefinitions, officeKinds } from './office';

export const hostDefinitions = [...officeDefinitions, ...engineeringDefinitions];
const entries = pairKinds(
  hostDefinitions,
  [...officeKinds({ verifyEstimate: verifyArtifactEstimate }), ...engineeringKinds],
  'Host adapter',
);

/** The Host adapter of each kind this Host opens. */
export const hostAdapters: Record<string, EditorHostAdapter<HostContent>> = Object.fromEntries(
  [...entries.values()].map((entry) => [entry.kind, entry.adapter]),
);

/** The name this Host lists a kind under. */
export const kindLabel = (kind: string) => entries.get(kind)?.label;

/** Reads a stored or imported native file of a kind this Host opens. */
export async function readNativeArtifact(
  kind: string,
  text: string,
): Promise<Artifact<HostContent>> {
  const entry = entries.get(kind);
  if (!entry) throw Error('Unknown artifact kind');
  return entry.parseNative ? entry.parseNative(text) : loadHostArtifact(text, entry.adapter);
}
