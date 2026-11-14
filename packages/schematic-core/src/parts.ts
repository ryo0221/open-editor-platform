import { generateFootprint } from '@editor-platform/pcb-core';
import type { SchematicFootprintRef, SchematicPart, SchematicSymbol } from './model';
import { schematicDefaultModel, schematicModelSpecs, type SchematicModel } from './models';
import { schematicPartSuggestion } from './symbols';

/**
 * Helpers for a part's SL2 fields (docs/cad/circuit-simulation.md, SL2), used by the Surface to
 * start a value the user then edits. Each result is plain data; the document's validation still
 * decides whether it is accepted.
 */

const collator = new Intl.Collator('en', { numeric: true });
const byNumber = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** The pad numbers of a footprint reference, in the footprint's order; throws if it makes none. */
export function schematicFootprintPads(ref: SchematicFootprintRef): string[] {
  return generateFootprint('pads', ref.generator, ref.params).pads.map((p) => p.number);
}

/**
 * Pins to pads in order: the symbol's pins sorted by number ("1", "2", … "10") onto the
 * footprint's pads as it lists them. Undefined when the footprint has fewer pads than the symbol
 * has pins (the user then maps by hand, or picks a larger footprint).
 */
export function schematicAutoPinMap(
  symbol: SchematicSymbol,
  ref: SchematicFootprintRef,
): Record<string, string> | undefined {
  const pads = schematicFootprintPads(ref);
  const pins = symbol.pins.map((p) => p.number).sort(byNumber);
  if (pads.length < pins.length) return undefined;
  return Object.fromEntries(pins.map((pin, i) => [pin, pads[i]]));
}

/**
 * A model of `kind` for `symbol`: the generator's suggestion when it is of that kind, else the
 * kind's defaults with its terminals on the symbol's pins in number order. Undefined when the
 * symbol has fewer pins than the kind has terminals.
 */
export function schematicModelFor(
  symbol: SchematicSymbol,
  kind: string,
): SchematicModel | undefined {
  const suggested = schematicPartSuggestion(symbol).model;
  if (suggested?.kind === kind) return suggested;
  const spec = schematicModelSpecs.get(kind);
  if (!spec) return undefined;
  const pins = symbol.pins.map((p) => p.number).sort(byNumber);
  if (pins.length < spec.terminals.length) return undefined;
  return schematicDefaultModel(
    kind,
    Object.fromEntries(spec.terminals.map((t, i) => [t, pins[i]])),
  );
}

/**
 * `part` with its footprint set (or removed) and the pin map rebuilt in order, or with `keep`
 * (a parameter of the same footprint changed) kept while it still fits.
 */
export function schematicWithFootprint(
  part: SchematicPart,
  symbol: SchematicSymbol,
  ref: SchematicFootprintRef | undefined,
  { keep = false }: { keep?: boolean } = {},
): SchematicPart {
  const { footprint: _f, pinMap: _m, ...rest } = part;
  if (!ref) return rest;
  // A map the user made is kept while every pin's pad is still in the new footprint; otherwise
  // it is rebuilt in order.
  if (keep && part.pinMap) {
    let pads: Set<string> | undefined;
    try {
      pads = new Set(schematicFootprintPads(ref));
    } catch {
      pads = undefined;
    }
    const used = symbol.pins.map((p) => part.pinMap![p.number]);
    if (
      pads &&
      used.every((pad) => pad !== undefined && pads.has(pad)) &&
      Object.keys(part.pinMap).length === used.length
    )
      return { ...rest, footprint: ref, pinMap: { ...part.pinMap } };
  }
  const pinMap = schematicAutoPinMap(symbol, ref);
  // Without enough pads the map is left empty: validation names the missing pins.
  return { ...rest, footprint: ref, pinMap: pinMap ?? {} };
}

/**
 * A footprint reference of `generator` sized for `symbol`'s pin count, so that choosing it can
 * map every pin: a header gets one row (two over 40 pins), SOIC an even pin count, QFN enough
 * pins per side (and a body to fit them), BGA a square grid (and its body), FPC and SH connectors that many pins, each within its
 * generator's range. Other generators (fixed pad sets and chips) start at their defaults.
 */
export function schematicFootprintStart(
  symbol: SchematicSymbol,
  generator: string,
): SchematicFootprintRef {
  const n = Math.max(symbol.pins.length, 1);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  switch (generator) {
    case 'pin-header': {
      const rows = n > 40 ? 2 : 1;
      return { generator, params: { rows, pinsPerRow: clamp(Math.ceil(n / rows), 1, 40) } };
    }
    case 'soic':
      return { generator, params: { pins: clamp(n + (n % 2), 4, 64) } };
    case 'qfn': {
      // At the default 0.5 mm pitch and 0.8 mm pads, the body grows so corner pads stay apart.
      const side = clamp(Math.ceil(n / 4), 2, 50);
      const size = Math.max(5, Math.ceil(((side - 1) * 0.5 + 1.5) * 10) / 10);
      return { generator, params: { pinsPerSide: side, size } };
    }
    case 'bga': {
      // At the default 0.8 mm pitch, the body grows to hold the grid.
      const side = clamp(Math.ceil(Math.sqrt(n)), 2, 40);
      const body = Math.max(10, Math.ceil(side * 0.8 + 1));
      return { generator, params: { rows: side, cols: side, bodyX: body, bodyY: body } };
    }
    case 'fpc':
      return { generator, params: { pins: clamp(n, 4, 60) } };
    case 'jst-sh':
      return { generator, params: { pins: clamp(n, 2, 20) } };
    default:
      return { generator, params: {} };
  }
}
