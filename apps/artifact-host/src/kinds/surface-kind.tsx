// The Artifact Host's Surface for a kind and the Host behaviour beside it, paired with the
// shared definition before the content type is erased (as the Playground's kinds/host-kind.tsx).
import type { ComponentType, ReactNode } from 'react';
import type { Artifact, StorageAdapter } from '@editor-platform/artifact-core';
import type { KindDefinition } from '@editor-platform/artifact-kinds';
import type { Region } from '@editor-platform/editor-core';
import type { ArtifactEditor } from '@editor-platform/editor-host';
import type { CadCatalogBuild, CadKernelCatalog } from '@editor-platform/cad-kernel-occt';
import type { HostContent } from '../content';
import type { compileProject } from '../compiler';

export type HostEditor = ArtifactEditor<HostContent>;
export type PanelLayout = {
  viewKey: string;
  panels:
    | { left: boolean; right: boolean; rightWidth: number; tab: 'properties'; focus: boolean }
    | undefined;
  onPanelsChange(value: unknown): void;
  defaultPanels: { left: boolean; right: boolean };
};

/** What the Host gives every Surface besides the editor and its checked content. */
export interface SurfaceEnvironment {
  previewDocument: string;
  /** A Host-supplied replacement for the Code view. */
  codeSurface?(host: HostEditor): ReactNode;
  cadKernel?: CadCatalogBuild | null;
  cadKernels?: Omit<CadKernelCatalog, 'current'>;
  onError(error: unknown): void;
  artifacts: Artifact<HostContent>[];
  storage: StorageAdapter<Artifact<HostContent>>;
  onCreated(artifact: Artifact<HostContent>): void;
  select(ids: string[], region?: Region): void;
  layout: PanelLayout;
}

export interface ArtifactSurfaceProps<C> {
  host: HostEditor;
  content: C;
  readOnly: boolean;
  env: SurfaceEnvironment;
}

export interface ToolsProps {
  host: HostEditor;
  previewDocument: string;
  onError(error: unknown): void;
}

export type ReactPreview = ReturnType<typeof compileProject>;

export interface ArtifactSurfaceParts<C, O extends C = C> {
  Surface: ComponentType<ArtifactSurfaceProps<O>>;
  /**
   * 'checked' (default): the Surface opens only content the kind validates (and `accepts`).
   * 'any': the Surface reads the editor itself and opens whatever the adapter loaded.
   */
  opens?: 'checked' | 'any';
  /** A further check before the Surface opens content (beyond the kind's validate). */
  accepts?(content: C): content is O;
  /** Undo/Redo when it is not the editor's own step (Fiction Map). */
  history?(host: HostEditor, direction: 'undo' | 'redo'): void;
  /** A preview of a saved Artifact in the list (the first page of a static deck). */
  ListPreview?: ComponentType<{ artifact: Artifact<HostContent>; content: O }>;
  /** Tools shown below the Surface. */
  Tools?: ComponentType<ToolsProps>;
  /** The Surface area's class name. Absent, `host-surface`. */
  surfaceClass?(options: { codeSurface: boolean }): string;
  /**
   * The React a saved Artifact compiles to when it is reused (Design): undefined when the content
   * is not reusable, throws on a bad bundle. Reads stored content, so it checks it itself.
   */
  reusePreview?(content: unknown): ReactPreview | undefined;
}

export interface ArtifactSurfaceEntry {
  readonly kind: string;
  readonly definition: KindDefinition<unknown>;
  render(host: HostEditor, env: SurfaceEnvironment): ReactNode | undefined;
  readonly history?: (host: HostEditor, direction: 'undo' | 'redo') => void;
  listPreview(artifact: Artifact<HostContent>): ReactNode;
  readonly Tools?: ComponentType<ToolsProps>;
  surfaceClass(options: { codeSurface: boolean }): string;
  /** Whether a saved Artifact of this kind is reused as React (Design). */
  readonly reusable: boolean;
  /** Undefined when the kind has no reuse preview or the content is not reusable. */
  reusePreview(content: unknown): ReactPreview | undefined;
}

export function artifactSurface<C, O extends C = C>(
  definition: KindDefinition<C>,
  parts: ArtifactSurfaceParts<NoInfer<C>, O>,
): ArtifactSurfaceEntry {
  const { Surface, accepts, ListPreview, surfaceClass, reusePreview } = parts;
  const checks = (content: unknown): content is O =>
    definition.validate(content) && (accepts ? accepts(content) : true);
  const entry: ArtifactSurfaceEntry = {
    kind: definition.kind,
    definition: definition as KindDefinition<unknown>,
    render(host, env) {
      const { content, readOnly } = host.snapshot;
      if (parts.opens !== 'any' && !checks(content)) return undefined;
      return <Surface host={host} content={content as O} readOnly={readOnly} env={env} />;
    },
    history: parts.history,
    listPreview: (artifact) => {
      const content = artifact.draft.content;
      return ListPreview && checks(content) ? (
        <ListPreview artifact={artifact} content={content} />
      ) : null;
    },
    Tools: parts.Tools,
    surfaceClass: (options) => (surfaceClass ? surfaceClass(options) : 'host-surface'),
    reusable: !!reusePreview,
    reusePreview: (content) => reusePreview?.(content),
  };
  return Object.freeze(entry);
}
