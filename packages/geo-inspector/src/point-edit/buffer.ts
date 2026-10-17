import type {
  AtomicSurfaceInputs,
  PreparedSurfaceCommand,
} from '@editor-platform/extension-contract/controlled-surface';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { GeoDocument } from '@editor-platform/geo-core';
import { draftFor, type PointDraft, type PointTarget } from './model';
export type PreparePoint = (
  snapshot: LocalReadSnapshot<GeoDocument>,
  draft: PointDraft,
) => PreparedSurfaceCommand<GeoDocument>;
/** One target-pinned aggregate buffer. A composition, even empty/cancelled, stays pending until Apply/Cancel. */
export class PointInputBuffer implements AtomicSurfaceInputs<GeoDocument> {
  readonly label = 'Geo Point coordinates and one scalar';
  private value: PointDraft | null = null;
  private pending = false;
  private composing = new Set<string>();
  constructor(
    private preparePoint: PreparePoint,
    public focus: () => void = () => {},
  ) {}
  read = () => ({ dirty: this.pending, composing: this.composing.size > 0 });
  draft = () => (this.value ? structuredClone(this.value) : null);
  select(snapshot: LocalReadSnapshot<GeoDocument>, target: PointTarget) {
    if (this.pending || this.composing.size) throw new Error('GeoPendingInputs');
    this.value = draftFor(snapshot, target);
  }
  change(values: Partial<Pick<PointDraft, 'longitude' | 'latitude' | 'scalar' | 'scalarNull'>>) {
    if (!this.value) throw new Error('GeoNoTarget');
    this.value = { ...this.value, ...values };
    this.pending = true;
  }
  composition(field: string, active: boolean) {
    if (!this.value) throw new Error('GeoNoTarget');
    this.pending = true;
    if (active) this.composing.add(field);
    else this.composing.delete(field);
  }
  prepare(snapshot: LocalReadSnapshot<GeoDocument>) {
    if (this.composing.size) throw new Error('GeoInputComposing');
    if (!this.value) throw new Error('GeoNoTarget');
    return this.preparePoint(snapshot, this.value);
  }
  committed(snapshot: LocalReadSnapshot<GeoDocument>) {
    if (this.value) this.value = draftFor(snapshot, this.value.target);
    this.pending = false;
    this.composing.clear();
  }
  cancel(snapshot: LocalReadSnapshot<GeoDocument>) {
    if (this.composing.size) throw new Error('GeoInputComposing');
    if (this.value) {
      try {
        this.value = draftFor(snapshot, this.value.target);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'GeoTargetMissing') throw error;
        this.value = null; // Explicit Cancel may abandon a deleted target; never retarget dirty input.
      }
    }
    this.pending = false;
  }
}
