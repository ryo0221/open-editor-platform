import type {
  GeoAction,
  GeoBackgroundSetting,
  GeoDocument,
  GeoExtent,
  GeoWorkspace,
} from '@editor-platform/geo-core';
import type {
  ControlledSurfaceController,
  ControlledSurfaceSnapshot,
  SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { GeoPngBundle } from './png';
import type { GeoWorkspaceHost } from './port';
import type { GeoDomKit } from './surface-dom';

export interface GeoSurfaceState {
  closed: boolean;
  featureDirty: boolean;
  styleDirty: boolean;
  base: LocalReadSnapshot<GeoDocument> | undefined;
  selected: { layerId: string; featureId: string } | null;
  scalarField: string;
  styleLayer: string;
  extent: GeoExtent;
  activeView: string;
  backgroundSettings: GeoBackgroundSetting[];
  backgroundTouched: boolean;
  png: { bundle: GeoPngBundle; stamp: string } | undefined;
  outputGeneration: number;
}

export interface GeoSurfaceElements {
  root: HTMLElement;
  status: HTMLParagraphElement;
  toolbar: HTMLDivElement;
  tabs: HTMLDivElement;
  sourcePanel: HTMLElement;
  mapPanel: HTMLElement;
  inspector: HTMLElement;
  tablePanel: HTMLElement;
  map: HTMLDivElement;
  legend: HTMLDivElement;
  form: HTMLDivElement;
  presentation: HTMLDivElement;
  table: HTMLDivElement;
  backgroundControls: HTMLDivElement;
  backgroundStatus: HTMLParagraphElement;
  downloads: HTMLDivElement;
}

export interface GeoFeatureControls {
  longitude: HTMLInputElement;
  latitude: HTMLInputElement;
  value: HTMLInputElement;
  isNull: HTMLInputElement;
  geometry: HTMLTextAreaElement;
}

export interface GeoStyleControls {
  mode: HTMLSelectElement;
  field: HTMLSelectElement;
  labelField: HTMLSelectElement;
  color: HTMLInputElement;
  missingColor: HTMLInputElement;
  radius: HTMLInputElement;
  categories: HTMLTextAreaElement;
  boundaries: HTMLInputElement;
  colors: HTMLInputElement;
  visible: HTMLInputElement;
  metricKind: HTMLSelectElement;
  numerator: HTMLSelectElement;
  denominator: HTMLSelectElement;
  multiplier: HTMLInputElement;
  indicator: HTMLInputElement;
  unit: HTMLInputElement;
  period: HTMLInputElement;
  filterField: HTMLSelectElement;
  filterValue: HTMLInputElement;
}

export type GeoFormControls = GeoFeatureControls & GeoStyleControls;

export type GeoInputBinding = ReturnType<ControlledSurfaceController<GeoDocument>['bindInputs']>;

export type GeoFormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export interface GeoSurfaceContext {
  doc: Document;
  editor: ControlledSurfaceController<GeoDocument>;
  host: GeoWorkspaceHost;
  kit: GeoDomKit;
  state: GeoSurfaceState;
  el: GeoSurfaceElements;
  controls: GeoFormControls;
  composing: Set<EventTarget>;
  urls: Set<string>;
  binding: GeoInputBinding;
  actionButtons: Record<'apply' | 'cancel' | 'undo' | 'redo', HTMLButtonElement>;
  retire(): void;
  open(): Extract<ControlledSurfaceSnapshot<GeoDocument>, { state: 'open' }>;
  pending(): boolean;
  requireClean(): void;
  workspace(): GeoWorkspace;
  showError(error: unknown): void;
  run(work: () => unknown): Promise<void>;
  button(parent: HTMLElement, name: string, work: () => unknown): HTMLButtonElement;
  mutate(actions: GeoAction[]): SurfaceOperation;
  currentFeature(): {
    content: GeoDocument;
    layer: GeoDocument['layers'][number];
    feature: GeoDocument['layers'][number]['features'][number];
  };
  watch(element: GeoFormControl, kind: 'feature' | 'style'): void;
  choose(layerId: string, featureId: string): void;
  updateButtons(): void;
  renderForms(): void;
  renderMapTable(): void;
  renderBackgroundControls(): void;
}
