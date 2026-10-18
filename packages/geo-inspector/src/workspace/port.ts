import type {
  GeoAction,
  GeoDocument,
  Budgets,
  Pin,
  GeoAsset,
  Scalar,
} from '@editor-platform/geo-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type {
  PreparedSurfaceCommand,
  SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import type { GeoPngBundle } from './png';

export interface GeoWorkspaceHost {
  signal: AbortSignal;
  budgets: Budgets;
  prepare(
    snapshot: LocalReadSnapshot<GeoDocument>,
    actions: GeoAction[],
  ): PreparedSurfaceCommand<GeoDocument>;
  /** Returns a verified retained immutable native version with complete original closure. */
  capture(versionId?: string): Promise<{ content: GeoDocument; pin: Pin }>;
  versions(): Promise<{ head: string | null; versionIds: string[] }>;
  /** Refuses pending input, save/open activity, stale revision, revoked permission/scope. */
  stamp(): string;
  /** Retire outstanding work on any newer private form input. */
  inputChanged?(): void;
  refresh(layerId: string, incomingLayerId: string): SurfaceOperation;
  previewRefreshFile(
    layerId: string,
    bytes: Uint8Array,
    name: string,
  ): Promise<{
    token: string;
    counts: { read: number; valid: number; problem: number };
    excludedRows: number[];
    changes: { externalId: Scalar; kind: 'added' | 'removed' | 'changed' | 'unchanged' }[];
    mapping: unknown;
  }>;
  applyRefreshFile(token: string, partial: boolean): Promise<SurfaceOperation>;
  attachPhoto(asset: GeoAsset, bytes: Uint8Array, name: string): Promise<SurfaceOperation>;
  photo(sourceId: string): Uint8Array;
  original?(sourceId: string): { bytes: Uint8Array; name: string; mediaType: string };
  placeOnSlide(bundle: GeoPngBundle): Promise<{ name: string; text: string }>;
}
