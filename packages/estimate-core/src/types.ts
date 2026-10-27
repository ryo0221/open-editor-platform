import type { WorkRule, WorkPlan, WorkResult } from './work';
import type { Rounding, SourcePin } from '@editor-platform/calculation-core';
export interface Override {
  value: string;
  reason: string;
}
export interface Quantity {
  id: string;
  name: string;
  unit: string;
  value: string | null;
  quality: 'manual' | 'cad' | 'analytic' | 'kernel';
  source?: {
    snapshotKey: string;
    identity: string;
    metric: string;
    scope: 'whole';
    coverage: string[];
    extractionBasis: string;
  };
  evidence: string;
  override?: Override;
  inclusion: 'include' | 'exclude' | 'pending';
  exclusionReason: string;
}
export interface Rate {
  id: string;
  name: string;
  unitPrice: string | null;
  perUnit: string;
  currency: string;
  evidence: string;
  override?: Override;
  source?: { snapshotKey: string; rowId: string; fieldId: string };
}
export interface Line {
  id: string;
  name: string;
  category: string;
  note: string;
  bindings: { quantityId: string; allocationRatio: string }[];
  rateId: string | null;
  wasteRatio: string;
  purchaseRounding?: { scale: number; rounding: Rounding };
  inclusion: 'include' | 'exclude' | 'pending';
  exclusionReason: string;
}
export interface Adjustment {
  id: string;
  name: string;
  kind: 'fixed' | 'percent';
  value: string;
  basisLineIds: string[];
  reason: string;
}
export interface Scenario {
  id: string;
  name: string;
  quantities: { id: string; value: string; reason: string }[];
  rates: { id: string; value: string; reason: string }[];
  waste: { id: string; value: string }[];
  workRules: WorkRule[];
}
export interface RetainedSource {
  key: string;
  pin: SourcePin;
  nativeContent: unknown;
  dependencies: string[];
}
export interface EstimateRecipe {
  currency: { code: string; minorDigits: number };
  rounding: Rounding;
  quantities: Quantity[];
  rates: Rate[];
  lines: Line[];
  adjustments: Adjustment[];
  workRules: WorkRule[];
  workPlan?: WorkPlan;
}
export interface EstimateBasis extends EstimateRecipe {
  engine: string;
  scenarioId: string | null;
  sources: string[];
}
export interface LineResult {
  id: string;
  name: string;
  category: string;
  unit: string;
  currency: string;
  adoptedQuantity: string;
  billableQuantity: string;
  unitPrice: string;
  unroundedCost: string;
  cost: string;
}
export interface EstimateResult {
  work?: WorkResult[];
  lines: LineResult[];
  adjustments: { id: string; value: string }[];
  subtotal: string;
  total: string | null;
  diagnostics: {
    code: string;
    id: string;
    message: string;
    target: 'quantity' | 'line' | 'adjustment' | 'work' | 'document';
  }[];
}
export interface Calculation {
  id: string;
  basis: EstimateBasis;
  basisHash: string;
  result: EstimateResult;
  resultHash: string;
}
export interface EstimateDocument extends EstimateRecipe {
  schemaVersion: 1;
  domain: 'estimate';
  title: string;
  description: string;
  scenarios: Scenario[];
  calculations: Calculation[];
  retainedSources: RetainedSource[];
}
export const ENGINE = 'estimate-1';
export const LIMITS = {
  quantities: 2000,
  rates: 1000,
  lines: 1000,
  adjustments: 1000,
  scenarios: 10,
  calculations: 5,
  sources: 8,
  bytes: 2097152,
} as const;
export function createEstimate(title = '見積・積算'): EstimateDocument {
  return {
    schemaVersion: 1,
    domain: 'estimate',
    title,
    description: '',
    currency: { code: 'JPY', minorDigits: 0 },
    rounding: 'half-up',
    quantities: [],
    rates: [],
    lines: [],
    adjustments: [],
    workRules: [],
    scenarios: [],
    calculations: [],
    retainedSources: [],
  };
}
