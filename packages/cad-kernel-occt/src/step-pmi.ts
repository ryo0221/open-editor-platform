import { cadPmiLimits, type CadPmiPresentation } from '@editor-platform/cad-core';
import type { P21File, P21Instance, P21Value } from '@editor-platform/geometry-core';
import type { OcModule } from '@editor-platform/geometry-kernel-occt';
import type { PmiFileCallout, PmiFilePresentation, PmiFileView } from './step-pmi-presentation';

/** Adds `value` to the list of `key`, in place. */
const append = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/**
 * PMI-1 (docs/cad/pmi.md): what a STEP file's product manufacturing information holds, what the
 * kernel's XDE reader read of it, and how the two compare. Nothing here is kept in the CAD
 * document yet (PMI-2), so every item the file holds is a loss of the import.
 */

/** The PMI families the file's text is counted by (each instance once, complex or simple). */
export type CadPmiFamily =
  | 'dimension'
  | 'geometric-tolerance'
  | 'datum'
  | 'datum-feature'
  | 'datum-target'
  | 'datum-system'
  | 'callout'
  | 'annotation'
  | 'view'
  | 'component-path'
  | 'other';

/** The families of PMI entities, by the leaf type names a file uses. */
const families: [CadPmiFamily, RegExp][] = [
  [
    'dimension',
    /^(?:DIMENSIONAL_(?:SIZE|LOCATION)\w*|ANGULAR_(?:SIZE|LOCATION)|DIRECTED_DIMENSIONAL_LOCATION)$/,
  ],
  // A dimension's `PLUS_MINUS_TOLERANCE` is part of the dimension.
  ['geometric-tolerance', /^(?!PLUS_MINUS_TOLERANCE$)(?:GEOMETRIC_TOLERANCE\w*|\w+_TOLERANCE)$/],
  ['datum-target', /^(?:DATUM_TARGET|PLACED_DATUM_TARGET_FEATURE)$/],
  ['datum-feature', /^(?:DATUM_FEATURE|COMPOSITE_GROUP_SHAPE_ASPECT_DATUM_FEATURE)$/],
  ['datum-system', /^DATUM_SYSTEM$/],
  ['datum', /^(?:DATUM|COMMON_DATUM)$/],
  ['callout', /^DRAUGHTING_CALLOUT\w*$/],
  ['annotation', /^(?:\w*ANNOTATION_\w*OCCURRENCE\w*)$/],
  ['view', /^CAMERA_MODEL_D3\w*$/],
  ['component-path', /^COMPONENT_PATH_SHAPE_ASPECT$/],
];
/**
 * Parts of an item rather than items: a tolerance's datum references, a dimension's link to its
 * representation and its plus/minus tolerance. The reader reads them with the item they belong to.
 */
const itemParts =
  /^(?:DATUM_REFERENCE\w*|GENERAL_DATUM_REFERENCE|DIMENSIONAL_CHARACTERISTIC_REPRESENTATION|PLUS_MINUS_TOLERANCE)$/;
/** The import's PMI detection (step-import.ts): an entity of it in no family is `other`. */
export const pmiEntity =
  /^(?:DIMENSIONAL_(?:SIZE|LOCATION|CHARACTERISTIC_REPRESENTATION)\w*|DATUM(?:_\w+)?|GEOMETRIC_TOLERANCE\w*|\w+_TOLERANCE|ANNOTATION_OCCURRENCE\w*|DRAUGHTING_CALLOUT\w*)$/;
export const familyOf = (type: string): CadPmiFamily | undefined =>
  families.find(([, re]) => re.test(type))?.[0] ??
  (pmiEntity.test(type) && !itemParts.test(type) ? 'other' : undefined);
/** Whether a type is PMI at all (an item, or a part of one). */
const isPmi = (type: string) => familyOf(type) !== undefined || itemParts.test(type);

/**
 * Instances of each PMI family in the file's text. A file whose PMI entities are all parts of
 * items (a datum reference without its tolerance) has an empty census, which is still PMI.
 */
export type CadPmiCensus = Partial<Record<CadPmiFamily, number>>;

/** Counts the PMI families of a read exchange structure; undefined when the file has none. */
export function pmiCensus(file: P21File): CadPmiCensus | undefined {
  const census: CadPmiCensus = {};
  let any = false;
  for (const e of file.entities.values()) {
    const found = new Set<CadPmiFamily>();
    for (const p of e.parts ?? [e]) {
      const family = familyOf(p.type);
      if (family) found.add(family);
      else if (isPmi(p.type)) any = true;
    }
    // A complex instance that is a tolerance with datums (`GEOMETRIC_TOLERANCE_WITH_DATUM_
    // REFERENCE` beside `POSITION_TOLERANCE`) is one tolerance.
    for (const family of found) {
      census[family] = (census[family] ?? 0) + 1;
      any = true;
    }
  }
  return any ? census : undefined;
}

/**
 * PMI-U1: the meaning of the file's dimensions, tolerances, datums and datum targets as read by
 * the own P21 reader, one signature per item, to be matched with what XDE read. A signature holds
 * the type, the values in mm or degrees, the signed deviations, a tolerance's modifiers and its
 * datums in compartment order with their simple modifiers, and the zone form (diameter or
 * spherical). Not compared: dimension modifiers, defined zones (projected, runout, non-uniform),
 * datum modifiers with a value or on a common datum's elements, and limits-and-fits classes:
 * an item with one of these never matches, so it is reported as not verified.
 * `targets` adds to each item's signature how many representation items each of its ends is
 * attached to in the file (`ITEM_IDENTIFIED_REPRESENTATION_USAGE` and its subtype
 * `GEOMETRIC_ITEM_SPECIFIC_USAGE`, through composite shape aspects):
 * a two-ended location with one end missing does not match. Which face is not compared (the
 * file's faces are not mapped to the kernel's face indices before PMI-2).
 */
export interface CadPmiSemantics {
  dimensions: string[];
  tolerances: { signature: string; systems: number[] }[];
  datums: string[];
  datumTargets: string[];
  targets: {
    dimension: string[];
    'geometric-tolerance': string[];
    datum: string[];
    'datum-target': string[];
  };
  /**
   * The datum features of each datum, checked together on the datum's target signature: a datum
   * defined by two features on one face each is read when the reader's datum is on two faces.
   */
  datumFeatures: { datum: string; features: number }[];
  /** `DATUM_SYSTEM` entities in the file. */
  systems: number[];
  /** PMI-3: the entity of each signature of `targets`, in the same order. */
  entities: Record<keyof CadPmiSemantics['targets'], number[]>;
}
/** PMI-5: one item of the file as this reader reads it (the fields its signature is made of). */
export type PmiTextItem =
  | {
      kind: 'dimension';
      entity: number;
      type: string;
      values: number[];
      deviation?: [number, number] | 'fit';
      /** `|q:max`-style qualifiers; `|modifiers?` when the dimension has modifiers. */
      qualifier: string;
      /** The aspect of each end: one for a size, two for a location. */
      ends: (number | undefined)[];
      signature: string;
    }
  | {
      kind: 'geometric-tolerance';
      entity: number;
      type: string;
      value: number;
      modifiers: string[];
      /** The datum system's compartments as `A,B-C(FREE_STATE)` (`systemLetters`). */
      datums: string;
      /** PMI-5a: the `DATUM` entities of each compartment, in the same order. */
      datumEntities: number[][];
      maximum?: number;
      zone?: string;
      aspect: number | undefined;
      signature: string;
    }
  | { kind: 'datum'; entity: number; letter: string; features: number[] };

type Part = { type: string; args: P21Value[] };
const partsOfInstance = (e: P21Instance): Part[] => e.parts ?? [e];
/** A number as signatures write it: 9 significant digits, so the reader's rounding matches. */
const num = (v: number) => String(Number(v.toPrecision(9)) + 0);
const siPrefix: Record<string, number> = {
  $: 1,
  EXA: 1e18,
  PETA: 1e15,
  TERA: 1e12,
  GIGA: 1e9,
  MEGA: 1e6,
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
  NANO: 1e-9,
  PICO: 1e-12,
};
/**
 * A unit's factor to mm (length) or degrees (plane angle; the reader gives angles in degrees);
 * undefined for any other unit or one that cannot be read. A conversion-based unit multiplies
 * its factor's unit (depth-limited).
 */
function unitFactor(
  file: P21File,
  ref: P21Value | undefined,
  depth = 0,
): { kind: 'length' | 'angle'; factor: number } | undefined {
  const e = ref?.t === 'ref' ? file.entities.get(ref.id) : undefined;
  if (!e || depth > 4) return undefined;
  const parts = partsOfInstance(e);
  const kind = parts.some((p) => p.type === 'LENGTH_UNIT')
    ? 'length'
    : parts.some((p) => p.type === 'PLANE_ANGLE_UNIT')
      ? 'angle'
      : undefined;
  if (!kind) return undefined;
  const si = parts.find((p) => p.type === 'SI_UNIT');
  if (si) {
    const [prefix, name] = si.args;
    const key = prefix?.t === 'enum' ? prefix.v : prefix?.t === 'unset' ? '$' : undefined;
    const scale = key === undefined ? undefined : siPrefix[key];
    if (scale === undefined || name?.t !== 'enum') return undefined;
    if (kind === 'length' && name.v === 'METRE') return { kind, factor: scale * 1000 };
    if (kind === 'angle' && name.v === 'RADIAN') return { kind, factor: (scale * 180) / Math.PI };
    return undefined;
  }
  const converted = parts.find((p) => p.type === 'CONVERSION_BASED_UNIT');
  const factor = converted?.args[1];
  const measure = factor?.t === 'ref' ? file.entities.get(factor.id) : undefined;
  const m = measure ? measureOf(file, measure, depth + 1) : undefined;
  return m && m.kind === kind ? { kind, factor: m.value } : undefined;
}
/** A measure-with-unit instance's value in mm or degrees. */
function measureOf(
  file: P21File,
  e: P21Instance,
  depth = 0,
): { kind: 'length' | 'angle'; value: number } | undefined {
  const withUnit = partsOfInstance(e).find(
    (p) => /MEASURE_WITH_UNIT$/.test(p.type) && p.args.length >= 2,
  );
  if (!withUnit) return undefined;
  const [component, unit] = withUnit.args;
  const value = component?.t === 'typed' ? component.v : component;
  if (value?.t !== 'real' && value?.t !== 'int') return undefined;
  const u = unitFactor(file, unit, depth);
  return u && { kind: u.kind, value: value.v * u.factor };
}
const refOf = (file: P21File, v: P21Value | undefined) =>
  v?.t === 'ref' ? file.entities.get(v.id) : undefined;
const str = (v: P21Value | undefined) => (v?.t === 'str' ? v.v.trim().toLowerCase() : '');

/** `DIMENSIONAL_SIZE`/`_LOCATION` names (ISO 10303-242), by the kernel's dimension types. */
const sizeNames: Record<string, string> = {
  'curve length': 'Size_CurveLength',
  diameter: 'Size_Diameter',
  'spherical diameter': 'Size_SphericalDiameter',
  radius: 'Size_Radius',
  'spherical radius': 'Size_SphericalRadius',
  'toroidal minor diameter': 'Size_ToroidalMinorDiameter',
  'toroidal major diameter': 'Size_ToroidalMajorDiameter',
  'toroidal minor radius': 'Size_ToroidalMinorRadius',
  'toroidal major radius': 'Size_ToroidalMajorRadius',
  'toroidal high major diameter': 'Size_ToroidalHighMajorDiameter',
  'toroidal low major diameter': 'Size_ToroidalLowMajorDiameter',
  'toroidal high major radius': 'Size_ToroidalHighMajorRadius',
  'toroidal low major radius': 'Size_ToroidalLowMajorRadius',
  thickness: 'Size_Thickness',
};
const locationNames: Record<string, string> = {
  'curved distance': 'Location_CurvedDistance',
  'linear distance': 'Location_LinearDistance',
  'linear distance centre outer': 'Location_LinearDistance_FromCenterToOuter',
  'linear distance centre inner': 'Location_LinearDistance_FromCenterToInner',
  'linear distance outer centre': 'Location_LinearDistance_FromOuterToCenter',
  'linear distance outer outer': 'Location_LinearDistance_FromOuterToOuter',
  'linear distance outer inner': 'Location_LinearDistance_FromOuterToInner',
  'linear distance inner centre': 'Location_LinearDistance_FromInnerToCenter',
  'linear distance inner outer': 'Location_LinearDistance_FromInnerToOuter',
  'linear distance inner inner': 'Location_LinearDistance_FromInnerToInner',
};
function dimensionType(parts: Part[]): string {
  const types = new Set(parts.map((p) => p.type));
  if (types.has('ANGULAR_LOCATION')) return 'Location_Angular';
  if (types.has('ANGULAR_SIZE')) return 'Size_Angular';
  if (types.has('DIMENSIONAL_LOCATION_WITH_PATH')) return 'Location_WithPath';
  if (types.has('DIMENSIONAL_SIZE_WITH_PATH')) return 'Size_WithPath';
  const size = parts.find((p) => p.type === 'DIMENSIONAL_SIZE');
  if (size) return sizeNames[str(size.args[1])] ?? `?${str(size.args[1])}`;
  const location = parts.find((p) => /^(?:DIRECTED_)?DIMENSIONAL_LOCATION$/.test(p.type));
  if (location) return locationNames[str(location.args[0])] ?? `?${str(location.args[0])}`;
  return '?';
}
/** Signature of a dimension: type, values (sorted for a range) and signed ± deviations. */
const dimensionSignature = (type: string, values: number[], pm?: [number, number] | 'fit') =>
  `${type}|${values.map(num).join(',')}|${pm === 'fit' ? 'fit' : pm ? pm.map(num).join(',') : ''}`;

/** STEP tolerance leaf types by the kernel's tolerance types. */
const toleranceNames: Record<string, string> = {
  ANGULARITY_TOLERANCE: 'Angularity',
  CIRCULAR_RUNOUT_TOLERANCE: 'CircularRunout',
  ROUNDNESS_TOLERANCE: 'CircularityOrRoundness',
  COAXIALITY_TOLERANCE: 'Coaxiality',
  CONCENTRICITY_TOLERANCE: 'Concentricity',
  CYLINDRICITY_TOLERANCE: 'Cylindricity',
  FLATNESS_TOLERANCE: 'Flatness',
  PARALLELISM_TOLERANCE: 'Parallelism',
  PERPENDICULARITY_TOLERANCE: 'Perpendicularity',
  POSITION_TOLERANCE: 'Position',
  LINE_PROFILE_TOLERANCE: 'ProfileOfLine',
  SURFACE_PROFILE_TOLERANCE: 'ProfileOfSurface',
  STRAIGHTNESS_TOLERANCE: 'Straightness',
  SYMMETRY_TOLERANCE: 'Symmetry',
  TOTAL_RUNOUT_TOLERANCE: 'TotalRunout',
};
/** `geometric_tolerance_modifier` names, in the order of the kernel's enumeration. */
export const pmiToleranceModifiers = Object.freeze([
  'ANY_CROSS_SECTION',
  'COMMON_ZONE',
  'EACH_RADIAL_ELEMENT',
  'FREE_STATE',
  'LEAST_MATERIAL_REQUIREMENT',
  'LINE_ELEMENT',
  'MAJOR_DIAMETER',
  'MAXIMUM_MATERIAL_REQUIREMENT',
  'MINOR_DIAMETER',
  'NOT_CONVEX',
  'PITCH_DIAMETER',
  'RECIPROCITY_REQUIREMENT',
  'SEPARATE_REQUIREMENT',
  'STATISTICAL_TOLERANCE',
  'TANGENT_PLANE',
  'ALL_AROUND',
  'ALL_OVER',
] as const);
/** The material condition is a modifier in the file and its own field in the reader. */
const materialModifiers: Record<string, string> = {
  MAXIMUM_MATERIAL_REQUIREMENT: 'M',
  LEAST_MATERIAL_REQUIREMENT: 'L',
};
/** `TOLERANCE_ZONE_FORM` names the reader turns into a `typeOfValue` (OCCT's `GetTolValueType`). */
const zoneFormValues: Record<string, string> = {
  'cylindrical or circular': 'D',
  spherical: 'SD',
};
const toleranceSignature = (type: string, value: number, modifiers: string[], datums: string) =>
  `${type}|${num(value)}|${modifiers
    .filter((m) => !materialModifiers[m])
    .sort()
    .join(',')}|${modifiers
    .map((m) => materialModifiers[m])
    .filter(Boolean)
    .join('')}|${datums}`;

/** `simple_datum_reference_modifier` names, in the order of `XCAFDimTolObjects_DatumSingleModif`. */
export const pmiDatumModifiers = Object.freeze([
  'ANY_CROSS_SECTION',
  'ANY_LONGITUDINAL_SECTION',
  'BASIC',
  'CONTACTING_FEATURE',
  'DEGREE_OF_FREEDOM_CONSTRAINT_U',
  'DEGREE_OF_FREEDOM_CONSTRAINT_V',
  'DEGREE_OF_FREEDOM_CONSTRAINT_W',
  'DEGREE_OF_FREEDOM_CONSTRAINT_X',
  'DEGREE_OF_FREEDOM_CONSTRAINT_Y',
  'DEGREE_OF_FREEDOM_CONSTRAINT_Z',
  'DISTANCE_VARIABLE',
  'FREE_STATE',
  'LEAST_MATERIAL_REQUIREMENT',
  'LINE',
  'MAJOR_DIAMETER',
  'MAXIMUM_MATERIAL_REQUIREMENT',
  'MINOR_DIAMETER',
  'ORIENTATION',
  'PITCH_DIAMETER',
  'PLANE',
  'POINT',
  'TRANSLATION',
] as const);
/** A compartment's datum modifiers as `(M1+M2)`, sorted; empty without any. */
const datumModifierText = (names: string[]) =>
  names.length ? `(${[...names].sort().join('+')})` : '';
/**
 * A compartment's modifiers from the file. Simple modifiers are compared; a modifier with a
 * value, or modifiers on the elements of a common datum, are not (the reader merges those), so
 * they give `(?)`, which the reader never gives: the tolerance stays unverified.
 */
function compartmentModifiers(
  file: P21File,
  mods: P21Value | undefined,
  base: P21Value | undefined,
): string {
  const list = base?.t === 'typed' ? base.v : base;
  if (list?.t === 'list')
    for (const v of list.v) {
      const element = refOf(file, v);
      const p = element && partsOfInstance(element).find((q) => q.args.length >= 5);
      const m = p?.args[5];
      if (m?.t === 'list' && m.v.length) return '(?)';
    }
  if (mods?.t !== 'list') return '';
  const names = mods.v.map((m) =>
    m.t === 'typed' && m.name === 'SIMPLE_DATUM_REFERENCE_MODIFIER' && m.v.t === 'enum'
      ? m.v.v
      : m.t === 'enum'
        ? m.v
        : '?',
  );
  return names.includes('?') ? '(?)' : datumModifierText(names);
}
/** `TYPE_QUALIFIER` names the reader keeps (OCCT's `GetDimQualifierType`). */
const typeQualifiers: Record<string, string> = { minimum: 'min', maximum: 'max', average: 'avg' };
/**
 * The qualifiers of a dimension's measures (`QUALIFIED_REPRESENTATION_ITEM`): a type qualifier
 * as `|q:max`. A value format (`NR2 2.1`) is how the value is shown, which belongs to the
 * presentation (PMI-3): OCCT 7.6 does not return it for the JAMA files. Any other qualifier
 * (precision, uncertainty) gives `|q:?`, which the reader never gives: not compared.
 */
function measureQualifiers(file: P21File, measures: (P21Instance | undefined)[]): string {
  let type = '';
  for (const m of measures)
    for (const p of m ? partsOfInstance(m) : [])
      if (p.type === 'QUALIFIED_REPRESENTATION_ITEM' && p.args[0]?.t === 'list')
        for (const v of p.args[0].v) {
          const q = refOf(file, v);
          const parts = q ? partsOfInstance(q) : [];
          const named = parts.find((x) => x.type === 'TYPE_QUALIFIER')?.args[0];
          const formatted = parts.find((x) => x.type === 'VALUE_FORMAT_TYPE_QUALIFIER')?.args[0];
          // An unknown qualifier, or two type qualifiers that differ, stay unknown.
          const next =
            named?.t === 'str'
              ? (typeQualifiers[named.v.trim().toLowerCase()] ?? '?')
              : formatted?.t === 'str'
                ? ''
                : '?';
          if (next) type = type === '?' || (type && type !== next) ? '?' : next;
        }
  return type ? `|q:${type}` : '';
}
/**
 * An angle's `angle_selection` is its qualifier in the reader (OCCT 7.6: equal → average,
 * large → maximum, small → minimum), in place of a measure's type qualifier.
 */
function angleQualifier(parts: Part[], qualifier: string): string {
  const angle = parts.find((p) => /^ANGULAR_(?:LOCATION|SIZE)$/.test(p.type));
  if (!angle || qualifier === '|q:?') return qualifier;
  const selection = angle.args.find((a) => a.t === 'enum');
  const q =
    selection?.t === 'enum' ? { EQUAL: 'avg', LARGE: 'max', SMALL: 'min' }[selection.v] : undefined;
  return q ? `|q:${q}` : qualifier;
}
/** Datum target types, in the order of `XCAFDimTolObjects_DatumTargetType`. */
const targetTypes = ['point', 'line', 'rectangle', 'circle', 'area'] as const;
/** Target types whose size is given by parameters. */
const sizedTargets = new Set(['line', 'rectangle', 'circle']);
/** The reader's datum target: datum letter, number and type. */
const readTarget = (d: PmiItemJson) =>
  `${`${d.name ?? '?'}${d.target?.number ?? '?'}`.toUpperCase()}|${
    d.target ? (targetTypes[d.target.type] ?? '?') : '?'
  }`;
/** A common datum's letters, each once in order (a datum twice is that datum). */
const commonDatum = (letters: string[]) => [...new Set(letters)].join('-');
/** A datum's letter through a compartment's or element's `base` (a datum, or a list of elements). */
function baseLetters(file: P21File, base: P21Value | undefined, depth = 0): string {
  if (depth > 4) return '?';
  // `COMMON_DATUM_LIST((#e1,#e2))`: a common datum of datum reference elements.
  const list = base?.t === 'typed' ? base.v : base;
  if (list?.t === 'list')
    return commonDatum(
      list.v.map((v) => {
        const element = refOf(file, v);
        const p = element && partsOfInstance(element).find((q) => q.args.length >= 5);
        return p ? baseLetters(file, p.args[4], depth + 1) : '?';
      }),
    );
  const e = refOf(file, base);
  const datum =
    e && partsOfInstance(e).find((p) => p.type === 'DATUM' || p.type === 'COMMON_DATUM');
  if (datum) return datum.args[4]?.t === 'str' ? datum.args[4].v.trim() : '?';
  // A `COMMON_DATUM` is a datum and a composite shape aspect of the datums it is made of.
  return '?';
}
/** The `DATUM` entities of a compartment's or element's `base`, in order (`baseLetters`). */
function baseDatums(file: P21File, base: P21Value | undefined, depth = 0): number[] {
  if (depth > 4) return [];
  const list = base?.t === 'typed' ? base.v : base;
  if (list?.t === 'list')
    return list.v.flatMap((v) => {
      const element = refOf(file, v);
      const p = element && partsOfInstance(element).find((q) => q.args.length >= 5);
      return p ? baseDatums(file, p.args[4], depth + 1) : [];
    });
  const e = refOf(file, base);
  return e && partsOfInstance(e).some((p) => p.type === 'DATUM' || p.type === 'COMMON_DATUM')
    ? [e.id]
    : [];
}
/** PMI-5a: a datum system's datum entities by compartment, as `systemLetters` orders them. */
function systemDatums(file: P21File, ref: P21Value | undefined): number[][] {
  const e = refOf(file, ref);
  if (!e) return [];
  const system = partsOfInstance(e).find((p) => p.type === 'DATUM_SYSTEM');
  if (system) {
    const list = system.args[4];
    return list?.t === 'list'
      ? list.v.map((c) => {
          const compartment = refOf(file, c);
          const p = compartment && partsOfInstance(compartment).find((q) => q.args.length >= 5);
          return p ? baseDatums(file, p.args[4]) : [];
        })
      : [];
  }
  const reference = partsOfInstance(e).find((p) => p.type === 'DATUM_REFERENCE');
  return reference ? [baseDatums(file, reference.args[1])] : [];
}
/** A datum system's letters in compartment order, `A,B-C`. */
function systemLetters(file: P21File, ref: P21Value | undefined): string {
  const e = refOf(file, ref);
  if (!e) return '?';
  const system = partsOfInstance(e).find((p) => p.type === 'DATUM_SYSTEM');
  if (system) {
    const list = system.args[4];
    return list?.t === 'list'
      ? list.v
          .map((c) => {
            const compartment = refOf(file, c);
            const p = compartment && partsOfInstance(compartment).find((q) => q.args.length >= 5);
            return p
              ? baseLetters(file, p.args[4]) + compartmentModifiers(file, p.args[5], p.args[4])
              : '?';
          })
          .join(',')
      : '?';
  }
  // AP214's `DATUM_REFERENCE(precedence, datum)`.
  const reference = partsOfInstance(e).find((p) => p.type === 'DATUM_REFERENCE');
  return reference ? baseLetters(file, reference.args[1]) : '?';
}

/** An AP214 `DATUM_REFERENCE`'s precedence (0 for anything else, which keeps its order). */
function referencePrecedence(file: P21File, ref: P21Value): number {
  const e = refOf(file, ref);
  const p = e && partsOfInstance(e).find((q) => q.type === 'DATUM_REFERENCE');
  const v = p?.args[0];
  return v?.t === 'int' || v?.t === 'real' ? v.v : 0;
}
/** PMI-U1: the semantics of a file's PMI, by its own P21 reader. */
export const pmiSemantics = (file: P21File): CadPmiSemantics => readPmiText(file).semantics;
/**
 * PMI-5: the semantics, and each dimension, tolerance and datum as read with the shape aspects
 * its ends stand on, for the items the kernel's reader does not read (`step-pmi-path.ts`).
 */
export function readPmiText(file: P21File): { semantics: CadPmiSemantics; texts: PmiTextItem[] } {
  const precedence = (ref: P21Value) => referencePrecedence(file, ref);
  const out: CadPmiSemantics = {
    dimensions: [],
    tolerances: [],
    datums: [],
    datumTargets: [],
    systems: [],
    targets: {
      dimension: [],
      'geometric-tolerance': [],
      datum: [],
      'datum-target': [],
    },
    datumFeatures: [],
    entities: { dimension: [], 'geometric-tolerance': [], datum: [], 'datum-target': [] },
  };
  const texts: PmiTextItem[] = [];
  // What each shape aspect is attached to: its own representation items, and those of the aspects a
  // composite aspect is made of (`SHAPE_ASPECT_RELATIONSHIP(name, desc, composite, member)`).
  const items = new Map<number, number>();
  const members = new Map<number, number[]>();
  const featuresOf = new Map<number, number[]>();
  const faces = (aspect: number | undefined, depth = 0): number =>
    aspect === undefined || depth > 8
      ? 0
      : (items.get(aspect) ?? 0) +
        (members.get(aspect) ?? []).reduce((n, m) => n + faces(m, depth + 1), 0);
  const refId = (v: P21Value | undefined) => (v?.t === 'ref' ? v.id : undefined);
  // The datum features defined for each datum letter.
  const featuresOfDatum = new Map<number, number[]>();
  // Each datum's entity and letter: datums of different parts may share a letter.
  const datumEntities: [number, string][] = [];
  // A dimension's values and deviations, by the dimension's entity.
  const values = new Map<number, number[]>();
  const deviations = new Map<number, [number, number] | 'fit'>();
  const measures = (e: P21Instance | undefined) => {
    const m = e && measureOf(file, e);
    return m ? [m.value] : [NaN];
  };
  // A representation's items other than measures (a `DESCRIPTIVE_REPRESENTATION_ITEM` such as
  // 'theoretical') are dimension modifiers, which are not compared: such a dimension is marked
  // so that it never matches and stays unverified.
  const modified = new Set<number>();
  // A dimension's measure qualifiers (`|q:max`, `|fmt:2.1`), by the dimension's entity.
  const qualifiers = new Map<number, string>();
  const isMeasure = (e: P21Instance | undefined) =>
    !!e && partsOfInstance(e).some((q) => /MEASURE_WITH_UNIT$/.test(q.type));
  // A tolerance's zone form, by `TOLERANCE_ZONE(name, desc, shape, pd, (tolerances), form)`;
  // a zone with a definition (projected, runout, non-uniform) is not compared.
  const zoneForms = new Map<number, { tolerances: number[]; form: string }>();
  const definedZones = new Set<number>();
  // A datum target's datum, by `SHAPE_ASPECT_RELATIONSHIP(name, desc, target, datum)`.
  const datumOf = new Map<number, string>();
  for (const e of file.entities.values())
    for (const p of partsOfInstance(e)) {
      if (p.type === 'DIMENSIONAL_CHARACTERISTIC_REPRESENTATION') {
        const dim = p.args[0];
        const rep = refOf(file, p.args[1]);
        const items = rep && partsOfInstance(rep).find((q) => q.args[1]?.t === 'list')?.args[1];
        if (
          dim?.t === 'ref' &&
          items?.t === 'list' &&
          items.v.some((i) => !isMeasure(refOf(file, i)))
        )
          modified.add(dim.id);
        if (dim?.t === 'ref' && items?.t === 'list')
          qualifiers.set(
            dim.id,
            measureQualifiers(file, items.v.map((i) => refOf(file, i)).filter(isMeasure)),
          );
        if (dim?.t === 'ref' && items?.t === 'list')
          values.set(
            dim.id,
            items.v
              .map((i) => refOf(file, i))
              .filter(isMeasure)
              .flatMap(measures)
              .sort((a, b) => a - b),
          );
      } else if (p.type === 'PLUS_MINUS_TOLERANCE') {
        const [range, dim] = p.args;
        const r = refOf(file, range);
        const tv = r && partsOfInstance(r).find((q) => q.type === 'TOLERANCE_VALUE');
        if (dim?.t !== 'ref') continue;
        if (!tv) deviations.set(dim.id, 'fit');
        else {
          const [lower] = measures(refOf(file, tv.args[0]));
          const [upper] = measures(refOf(file, tv.args[1]));
          deviations.set(dim.id, [lower, upper]);
        }
      } else if (p.type === 'TOLERANCE_ZONE') {
        const [, , , , tolerances, form] = p.args;
        const f = refOf(file, form);
        const name = f && partsOfInstance(f).find((q) => q.type === 'TOLERANCE_ZONE_FORM')?.args[0];
        zoneForms.set(e.id, {
          tolerances:
            tolerances?.t === 'list'
              ? tolerances.v.flatMap((v) => (v.t === 'ref' ? [v.id] : []))
              : [],
          form: name?.t === 'str' ? name.v.trim().toLowerCase() : '?',
        });
      } else if (/ZONE_DEFINITION$/.test(p.type) && p.args[0]?.t === 'ref') {
        // A definition adds meaning with boundaries, a projection, an orientation or a
        // non-uniform zone; OCCT 8's writer adds an empty `RUNOUT_ZONE_DEFINITION(zone, ())`.
        const [, boundaries, extra] = p.args;
        if (
          p.type !== 'RUNOUT_ZONE_DEFINITION' ||
          (boundaries?.t === 'list' && boundaries.v.length) ||
          (extra && extra.t !== 'unset')
        )
          definedZones.add(p.args[0].id);
      } else if (p.type === 'DATUM_SYSTEM') out.systems.push(e.id);
      else if (p.type === 'SHAPE_ASPECT_RELATIONSHIP') {
        const [, , relating, related] = p.args;
        const datum = refOf(file, related);
        const letter = datum && partsOfInstance(datum).find((q) => q.type === 'DATUM')?.args[4];
        if (relating?.t === 'ref' && letter?.t === 'str') {
          datumOf.set(relating.id, letter.v.trim());
          if (related?.t === 'ref')
            featuresOfDatum.set(related.id, [
              ...(featuresOfDatum.get(related.id) ?? []),
              relating.id,
            ]);
        } else if (relating?.t === 'ref' && related?.t === 'ref')
          append(members, relating.id, related.id);
      } else if (p.type === 'FEATURE_FOR_DATUM_TARGET_RELATIONSHIP') {
        // A placed datum target is on the feature that relates to it.
        const [, , feature, target] = p.args;
        if (feature?.t === 'ref' && target?.t === 'ref') append(featuresOf, target.id, feature.id);
      } else if (
        p.type === 'GEOMETRIC_ITEM_SPECIFIC_USAGE' ||
        p.type === 'ITEM_IDENTIFIED_REPRESENTATION_USAGE'
      ) {
        // The items an aspect is attached to: faces and edges of the solid, or the curves and
        // points of a wireframe (a centre line). `SET_REPRESENTATION_ITEM((…))` lists several.
        const [, , definition, , identified] = p.args;
        const value = identified?.t === 'typed' ? identified.v : identified;
        const n = value?.t === 'list' ? value.v.length : value?.t === 'ref' ? 1 : 0;
        if (definition?.t === 'ref' && n)
          items.set(definition.id, (items.get(definition.id) ?? 0) + n);
      }
    }
  // The reader's `typeOfValue` from the zone form: diameter, spherical diameter or none.
  const zoneOf = new Map<number, string>();
  for (const [id, zone] of zoneForms)
    for (const t of zone.tolerances) {
      const form = definedZones.has(id) ? '?' : (zoneFormValues[zone.form] ?? '?');
      zoneOf.set(t, zoneOf.has(t) ? '?' : form);
    }
  for (const e of file.entities.values()) {
    const parts = partsOfInstance(e);
    const families = new Set(parts.map((p) => familyOf(p.type)));
    if (families.has('dimension')) {
      const signature =
        dimensionSignature(dimensionType(parts), values.get(e.id) ?? [], deviations.get(e.id)) +
        angleQualifier(parts, qualifiers.get(e.id) ?? '') +
        (modified.has(e.id) ? '|modifiers?' : '');
      out.dimensions.push(signature);
      // A complex `(ANGULAR_LOCATION(.EQUAL.) DIMENSIONAL_LOCATION(name, desc, a, b))` has its
      // ends in the supertype's partial entity; a simple subtype instance has them first.
      const size =
        parts.find((p) => p.type === 'DIMENSIONAL_SIZE' && p.args.length >= 2) ??
        parts.find((p) => /^(?:DIMENSIONAL_SIZE|ANGULAR_SIZE)/.test(p.type) && p.args.length >= 2);
      const location =
        parts.find(
          (p) => /^(?:DIRECTED_)?DIMENSIONAL_LOCATION$/.test(p.type) && p.args.length >= 4,
        ) ??
        parts.find(
          (p) => /DIMENSIONAL_LOCATION|ANGULAR_LOCATION/.test(p.type) && p.args.length >= 4,
        );
      const ends = size
        ? [faces(refId(size.args[0]))]
        : location
          ? [faces(refId(location.args[2])), faces(refId(location.args[3]))]
          : [];
      out.targets.dimension.push(`${signature}|${ends.join(',')}`);
      out.entities.dimension.push(e.id);
      texts.push({
        kind: 'dimension',
        entity: e.id,
        type: dimensionType(parts),
        values: values.get(e.id) ?? [],
        ...(deviations.has(e.id) && { deviation: deviations.get(e.id) }),
        qualifier:
          angleQualifier(parts, qualifiers.get(e.id) ?? '') +
          (modified.has(e.id) ? '|modifiers?' : ''),
        ends: size
          ? [refId(size.args[0])]
          : location
            ? [refId(location.args[2]), refId(location.args[3])]
            : [],
        signature,
      });
    } else if (families.has('geometric-tolerance')) {
      const types = parts.map((p) => toleranceNames[p.type]).filter(Boolean);
      // The magnitude and datum system sit in the supertype's attributes, or after them in a
      // simple instance of a subtype (`PARALLELISM_TOLERANCE(name, desc, m, aspect, (systems))`).
      const head = parts.find((p) => p.args.length >= 4 && p.args[2]?.t === 'ref');
      const m = head && refOf(file, head.args[2]);
      const value = (m && measureOf(file, m)?.value) ?? NaN;
      const withRefs =
        parts.find((p) => p.type === 'GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE')?.args[0] ??
        (head && head.args[4]?.t === 'list' ? head.args[4] : undefined);
      const systems = withRefs?.t === 'list' ? withRefs.v : [];
      const withModifiers = parts.find((p) => p.type === 'GEOMETRIC_TOLERANCE_WITH_MODIFIERS');
      const modifierList =
        withModifiers?.args[0] ?? (head && head.args[5]?.t === 'list' ? head.args[5] : undefined);
      const modifiers =
        modifierList?.t === 'list' ? modifierList.v.map((v) => (v.t === 'enum' ? v.v : '?')) : [];
      const zone = zoneOf.get(e.id);
      // `GEOMETRIC_TOLERANCE_WITH_MAXIMUM_TOLERANCE(maximum_upper_tolerance)`, in mm.
      const withMaximum = parts.find((p) => p.type === 'GEOMETRIC_TOLERANCE_WITH_MAXIMUM_TOLERANCE')
        ?.args[0];
      const maximumMeasure = withMaximum && refOf(file, withMaximum);
      const maximum = withMaximum
        ? ((maximumMeasure && measureOf(file, maximumMeasure)?.value) ?? NaN)
        : undefined;
      // The reader lists a tolerance's datums as one sequence of compartments: AP242's datum
      // system, or AP214's `DATUM_REFERENCE`s in precedence order.
      const ordered = [...systems].sort((a, b) => precedence(a) - precedence(b));
      const datums = ordered.map((r) => systemLetters(file, r)).join(',');
      const datumEntities = ordered.flatMap((r) => systemDatums(file, r));
      const signature =
        toleranceSignature(types.length === 1 ? types[0]! : '?', value, modifiers, datums) +
        (maximum !== undefined ? `|max:${num(maximum)}` : '') +
        (zone ? `|zone:${zone}` : '');
      out.tolerances.push({
        signature,
        systems: systems.flatMap((r) => (r.t === 'ref' ? [r.id] : [])),
      });
      out.targets['geometric-tolerance'].push(`${signature}|${faces(refId(head?.args[3]))}`);
      out.entities['geometric-tolerance'].push(e.id);
      texts.push({
        kind: 'geometric-tolerance',
        entity: e.id,
        type: types.length === 1 ? types[0]! : '?',
        value,
        modifiers,
        datums,
        datumEntities,
        ...(maximum !== undefined && { maximum }),
        ...(zone && { zone }),
        aspect: refId(head?.args[3]),
        signature,
      });
    } else if (families.has('datum-target')) {
      const target = parts.find((p) => p.type === 'DATUM_TARGET' || p.args.length >= 5);
      // The target's type is its description ('point', 'circle', …). The size of a line,
      // rectangle or circle is in parameters the reader's JSON does not return (PMI-2): such a
      // target is not compared.
      const kind = target?.args[1]?.t === 'str' ? target.args[1].v.trim().toLowerCase() : '?';
      const signature = target
        ? `${datumOf.get(e.id) ?? '?'}${str(target.args[4]).toUpperCase()}|${
            targetTypes.includes(kind as (typeof targetTypes)[number]) ? kind : '?'
          }${sizedTargets.has(kind) ? '|size?' : ''}`
        : '?';
      out.datumTargets.push(signature);
      const on = [e.id, ...(featuresOf.get(e.id) ?? [])].reduce((n, a) => n + faces(a), 0);
      out.targets['datum-target'].push(`${signature}|${on}`);
      out.entities['datum-target'].push(e.id);
    } else if (families.has('datum')) {
      const datum = parts.find((p) => p.type === 'DATUM' || p.type === 'COMMON_DATUM');
      const letter = datum?.args[4]?.t === 'str' ? datum.args[4].v.trim() : '?';
      out.datums.push(letter);
      datumEntities.push([e.id, letter]);
    }
  }
  // A datum is on the faces of its datum features, which are checked together with it.
  for (const [id, letter] of datumEntities) {
    const features = featuresOfDatum.get(id) ?? [];
    texts.push({ kind: 'datum', entity: id, letter, features });
    const datum = `${letter}|${features.reduce((n, f) => n + faces(f), 0)}`;
    out.targets.datum.push(datum);
    out.entities.datum.push(id);
    const count = features.filter((f) =>
      partsOfInstance(file.entities.get(f) ?? { id: 0, type: '', args: [] }).some(
        (q) => familyOf(q.type) === 'datum-feature',
      ),
    ).length;
    if (count) out.datumFeatures.push({ datum, features: count });
  }
  return { semantics: out, texts };
}

/**
 * The kernel's enumerations by their integer values (OCCT 7.6, `XCAFDimTolObjects_*Type`), as
 * the helper's JSON gives them. Names drop the type's prefix.
 */
export const pmiDimensionTypes = Object.freeze([
  'Location_None',
  'Location_CurvedDistance',
  'Location_LinearDistance',
  'Location_LinearDistance_FromCenterToOuter',
  'Location_LinearDistance_FromCenterToInner',
  'Location_LinearDistance_FromOuterToCenter',
  'Location_LinearDistance_FromOuterToOuter',
  'Location_LinearDistance_FromOuterToInner',
  'Location_LinearDistance_FromInnerToCenter',
  'Location_LinearDistance_FromInnerToOuter',
  'Location_LinearDistance_FromInnerToInner',
  'Location_Angular',
  'Location_Oriented',
  'Location_WithPath',
  'Size_CurveLength',
  'Size_Diameter',
  'Size_SphericalDiameter',
  'Size_Radius',
  'Size_SphericalRadius',
  'Size_ToroidalMinorDiameter',
  'Size_ToroidalMajorDiameter',
  'Size_ToroidalMinorRadius',
  'Size_ToroidalMajorRadius',
  'Size_ToroidalHighMajorDiameter',
  'Size_ToroidalLowMajorDiameter',
  'Size_ToroidalHighMajorRadius',
  'Size_ToroidalLowMajorRadius',
  'Size_Thickness',
  'Size_Angular',
  'Size_WithPath',
  'CommonLabel',
  'DimensionPresentation',
] as const);
export const pmiToleranceTypes = Object.freeze([
  'None',
  'Angularity',
  'CircularRunout',
  'CircularityOrRoundness',
  'Coaxiality',
  'Concentricity',
  'Cylindricity',
  'Flatness',
  'Parallelism',
  'Perpendicularity',
  'Position',
  'ProfileOfLine',
  'ProfileOfSurface',
  'Straightness',
  'Symmetry',
  'TotalRunout',
] as const);

/** One sub-shape a PMI item is attached to, as the kernel's helper names it. */
export interface PmiTargetJson {
  label: string;
  /** `TopAbs_ShapeEnum` of the sub-shape; -1 when the label has no shape. */
  shape: number;
  product?: string;
  /** 1-based index in `TopExp::MapShapes` of the product's shape; 0 when not found. */
  index?: number;
}
export interface PmiItemJson {
  label: string;
  /** Dimensions and tolerances: the type's integer value (`pmiDimensionTypes`, `pmiToleranceTypes`). */
  type?: number;
  /** A dimension's values (nominal first; with a ±tolerance, then lower and upper). */
  values?: number[];
  plusMinus?: boolean;
  /** OCCT 7.6 reads the lower deviation as a magnitude (the file's sign is not kept). */
  lowerTol?: number;
  upperTol?: number;
  /** A tolerance's value. */
  value?: number;
  /** A tolerance's datum labels, in compartment order. */
  datums?: string[];
  /** Modifiers: a tolerance's are `pmiToleranceModifiers` and a datum's `pmiDatumModifiers` by index. */
  modifiers?: number[];
  /** A datum's compartment position; datums of a common datum share it. */
  position?: number;
  /** A tolerance's zone form (`XCAFDimTolObjects_GeomToleranceTypeValue`: 0 none, 1 diameter, 2 spherical diameter). */
  typeOfValue?: number;
  /** A dimension's qualifier (`XCAFDimTolObjects_DimensionQualifier`: 1 min, 2 max, 3 avg; −1 none). */
  qualifier?: number;
  /** A dimension's decimal places before and after the point, from its value format. */
  decimals?: [number, number];
  /** A tolerance's maximum tolerance, 0 without one. */
  maxValue?: number;
  /** A tolerance's zone modifier (`XCAFDimTolObjects_GeomToleranceZoneModif`: 0 none, 1 projected, 2 runout, 3 non-uniform). */
  zone?: number;
  /** A tolerance's material condition (`XCAFDimTolObjects_GeomToleranceMatReqModif`: 0 none, 1 M, 2 L). */
  material?: number;
  /** A dimension's limits-and-fits class, null without one. */
  classOfTolerance?: unknown;
  range?: boolean;
  /** A datum's letter, a dimension's semantic name. */
  name?: string;
  /** Whether the label carries the reader's object (`XCAFDimTolObjects_*Object`). */
  object: boolean;
  targets: PmiTargetJson[];
  targets2?: PmiTargetJson[];
  presentation?: { edges: number; faces: number; segments: number[] } | null;
  /** A datum's target (`DATUM_TARGET`), null for a datum. */
  target?: { type: number; number: number } | null;
}
export interface PmiViewJson {
  label: string;
  object: boolean;
  gdt?: string[];
}
/** The JSON of `OCJS::pmiJson` (scripts/cad-kernel/opencascade.d0-leakcheck.yml). */
export interface CadPmiJson {
  dimensions: PmiItemJson[];
  tolerances: PmiItemJson[];
  datums: PmiItemJson[];
  views: PmiViewJson[];
}

/** The kinds of the reader's items, by the census family each is compared with. */
/**
 * The reader gives a datum once for each tolerance that references it (F43: datum A of two
 * tolerances is two labels), so datums are compared as one per letter, target and datum target.
 */
export function distinctDatums(datums: PmiItemJson[]): PmiItemJson[] {
  const seen = new Map<string, PmiItemJson>();
  for (const d of datums) {
    const key = datumKey(d);
    // An item with its object wins over one without, so a duplicate does not hide a read.
    if (!seen.has(key) || (!seen.get(key)!.object && d.object)) seen.set(key, d);
  }
  return [...seen.values()];
}
const readKinds: [CadPmiFamily, (json: CadPmiJson) => PmiItemJson[]][] = [
  ['dimension', (j) => j.dimensions],
  ['geometric-tolerance', (j) => j.tolerances],
  ['datum', (j) => distinctDatums(j.datums.filter((d) => !d.target))],
  ['datum-target', (j) => distinctDatums(j.datums.filter((d) => d.target))],
];

/**
 * One comparison of the file's text with what the reader read (PMI-U1): one axis of one family.
 * `unread` is what the file holds that the reader did not give as a complete item.
 */
export interface CadPmiAxis {
  /** PMI-5a: `path` rows count the items read through assembly paths by the own reader. */
  axis: 'semantic' | 'target' | 'presentation' | 'view' | 'path' | 'unsupported';
  family: CadPmiFamily;
  inFile: number;
  read: number;
  unread: number;
}
/**
 * The PMI section of an import report. PMI-1 keeps none of it in the CAD document: `kept` is 0
 * and every item the file holds is lost, read or not. The source STEP is still kept as before.
 */
export interface CadStepPmiReport {
  census: CadPmiCensus;
  /** Items the reader gave, by kind; undefined when this build cannot read PMI. */
  read?: { dimensions: number; tolerances: number; datums: number; views: number };
  axes: CadPmiAxis[];
  /**
   * PMI-2: verified items kept in the document's `pmi` assets, by kind (0 until the import
   * resolved them onto its bodies).
   */
  kept: Record<
    'dimension' | 'geometric-tolerance' | 'datum' | 'datum-target' | 'callout' | 'view',
    number
  >;
  /** True when every family and axis matched. */
  complete: boolean;
  /** PMI-5a: the items through assembly paths that were not kept, by why (`PmiPathProblem`). */
  pathProblems?: Partial<Record<string, number>>;
  /**
   * PMI-2: true when nothing of the file's PMI is lost: every item read, verified and kept,
   * every callout shown with a kept item (PMI-3a) and every saved view kept (PMI-3b).
   */
  lossless: boolean;
}

/** No item kept yet. */
export const noPmiKept = (): CadStepPmiReport['kept'] => ({
  dimension: 0,
  'geometric-tolerance': 0,
  datum: 0,
  'datum-target': 0,
  callout: 0,
  view: 0,
});

/** Whether a report with `kept` loses nothing of the file's PMI (PMI-2). */
export function pmiLossless(report: Omit<CadStepPmiReport, 'lossless'>): boolean {
  const { census, kept } = report;
  return (
    report.complete &&
    (Object.keys(kept) as (keyof typeof kept)[]).every((k) => kept[k] === (census[k] ?? 0))
  );
}

/** Whether a target names a face, edge or vertex of a product found by its index. */
const resolved = (t: PmiTargetJson) =>
  t.product !== undefined && typeof t.index === 'number' && t.index > 0 && t.shape >= 0;

/** The reader's dimension as a signature of `pmiSemantics`. */
function readDimension(d: PmiItemJson): string {
  const type = d.type === undefined ? '?' : (pmiDimensionTypes[d.type] ?? '?');
  const values = d.values ?? [];
  const nominal = d.plusMinus ? values.slice(0, 1) : [...values].sort((a, b) => a - b);
  // OCCT 7.6 keeps the lower deviation as a magnitude below the nominal: a file whose lower
  // bound is above the nominal does not match. A limits-and-fits class is not compared.
  const pm: [number, number] | undefined = d.plusMinus
    ? [-Math.abs(d.lowerTol ?? NaN), d.upperTol ?? NaN]
    : undefined;
  const qualifier =
    d.qualifier === undefined || d.qualifier < 1
      ? ''
      : (['', 'min', 'max', 'avg'][d.qualifier] ?? '?');
  const signature = dimensionSignature(type, nominal, pm) + (qualifier ? `|q:${qualifier}` : '');
  return d.classOfTolerance ? `${signature}|fit?` : signature;
}
/** The reader's datum letters of a tolerance: compartments in order, a common datum's joined. */
function readDatums(t: PmiItemJson, datums: Map<string, PmiItemJson>): string {
  const groups: { position: number | undefined; names: string[]; modifiers: string }[] = [];
  for (const label of t.datums ?? []) {
    const d = datums.get(label);
    // The reader gives each datum its compartment's simple modifiers.
    const modifiers = datumModifierText(
      (d?.modifiers ?? []).map((m) => pmiDatumModifiers[m] ?? `#${m}`),
    );
    const last = groups[groups.length - 1];
    if (last && d?.position !== undefined && last.position === d.position)
      last.names.push(d.name ?? '?');
    else groups.push({ position: d?.position, names: [d?.name ?? '?'], modifiers });
  }
  return groups.map((g) => commonDatum(g.names) + g.modifiers).join(',');
}
function readTolerance(t: PmiItemJson, datums: Map<string, PmiItemJson>): string {
  return (
    toleranceSignature(
      t.type === undefined ? '?' : (pmiToleranceTypes[t.type] ?? '?'),
      t.value ?? NaN,
      [
        ...(t.modifiers ?? []).map((m) => pmiToleranceModifiers[m] ?? '?'),
        ...(t.material
          ? [
              t.material === 1
                ? 'MAXIMUM_MATERIAL_REQUIREMENT'
                : t.material === 2
                  ? 'LEAST_MATERIAL_REQUIREMENT'
                  : '?',
            ]
          : []),
      ],
      readDatums(t, datums),
    ) +
    // OCCT 7.6 keeps the maximum in the file's unit (no length factor): a file not in mm does
    // not match.
    (t.maxValue ? `|max:${num(t.maxValue)}` : '') +
    readZone(t)
  );
}
/** The reader's zone: a diameter or spherical diameter form; a zone modifier is not compared. */
function readZone(t: PmiItemJson): string {
  if (t.zone) return '|zone:modifier';
  return t.typeOfValue === 1 ? '|zone:D' : t.typeOfValue === 2 ? '|zone:SD' : '';
}
/** Matches signatures one to one; returns the matched indices of `file`. */
function match(file: string[], read: string[]): Set<number> {
  const free = new Map<string, number[]>();
  file.forEach((sig, i) => append(free, sig, i));
  const matched = new Set<number>();
  for (const sig of read) {
    const i = free.get(sig)?.shift();
    if (i !== undefined) matched.add(i);
  }
  return matched;
}

/**
 * Compares the census and the file's semantics with the reader's items on separate axes
 * (PMI-U1). `semantic`: items whose meaning (`pmiSemantics`) matches one of the file's, one to
 * one; `target`: items with an object whose every target resolves to a product's sub-shape;
 * `presentation`, `view`; families no axis checks are `unsupported`.
 */
export function comparePmi(
  census: CadPmiCensus,
  json: CadPmiJson | undefined,
  semantics: CadPmiSemantics,
  /** PMI-3a: the file's presentation as the own reader read it. */
  presentation?: PmiFilePresentation,
): CadStepPmiReport {
  const axes: CadPmiAxis[] = [];
  const add = (axis: CadPmiAxis['axis'], family: CadPmiFamily, inFile: number, read: number) =>
    axes.push({
      axis,
      family,
      inFile,
      read: Math.min(read, inFile),
      unread: Math.max(0, inFile - read),
    });
  if (!json) {
    for (const [family, n] of Object.entries(census) as [CadPmiFamily, number][])
      add('unsupported', family, n, 0);
    return { census, axes, kept: noPmiKept(), complete: false, lossless: false };
  }
  const byLabel = new Map(json.datums.map((d) => [d.label, d]));
  const matchedTolerances = match(
    semantics.tolerances.map((t) => t.signature),
    json.tolerances.filter((t) => t.object).map((t) => readTolerance(t, byLabel)),
  );
  const meaning: Record<string, (items: PmiItemJson[]) => number> = {
    dimension: (items) => match(semantics.dimensions, items.map(readDimension)).size,
    'geometric-tolerance': () => matchedTolerances.size,
    datum: (items) =>
      match(
        semantics.datums,
        items.map((d) => d.name ?? '?'),
      ).size,
    'datum-target': (items) => match(semantics.datumTargets, items.map(readTarget)).size,
  };
  // The target axis: the item's meaning and how many sub-shapes each end is on, matched with the
  // file's, for items whose every target resolves to a product's sub-shape (which face is not
  // compared; see `CadPmiSemantics`).
  const onShapes = (i: PmiItemJson) =>
    i.targets.length > 0 && [...i.targets, ...(i.targets2 ?? [])].every(resolved);
  const located = (d: PmiItemJson) =>
    d.type !== undefined && /^Location_/.test(pmiDimensionTypes[d.type] ?? '');
  const ends: Record<string, (i: PmiItemJson) => string> = {
    dimension: (d) =>
      `${readDimension(d)}|${located(d) ? `${d.targets.length},${d.targets2?.length ?? 0}` : d.targets.length}`,
    'geometric-tolerance': (t) => `${readTolerance(t, byLabel)}|${t.targets.length}`,
    datum: (d) => `${d.name ?? '?'}|${d.targets.length}`,
    'datum-target': (d) => `${readTarget(d)}|${d.targets.length}`,
  };
  for (const [family, of] of readKinds) {
    const inFile = census[family] ?? 0;
    const items = of(json);
    if (!inFile && !items.length) continue;
    const objects = items.filter((i) => i.object);
    add('semantic', family, inFile, meaning[family](objects));
    const sigs = semantics.targets[family as keyof CadPmiSemantics['targets']];
    add('target', family, inFile, match(sigs, objects.filter(onShapes).map(ends[family])).size);
  }
  // A datum feature is the faces a datum is defined on: a datum's features are read together
  // when the reader's datum is on as many faces as all of them.
  if (census['datum-feature'])
    add(
      'target',
      'datum-feature',
      census['datum-feature'],
      [
        ...match(
          semantics.datumFeatures.map((g) => g.datum),
          distinctDatums(json.datums.filter((d) => d.object && !d.target))
            .filter(onShapes)
            .map(ends.datum),
        ),
      ].reduce((n, i) => n + semantics.datumFeatures[i].features, 0),
    );
  // A datum system is checked with the tolerances that reference it.
  if (census['datum-system']) {
    const systems = new Set(semantics.systems);
    const read = new Set([...matchedTolerances].flatMap((i) => semantics.tolerances[i].systems));
    add(
      'semantic',
      'datum-system',
      census['datum-system'],
      [...read].filter((id) => systems.has(id)).length,
    );
  }
  // PMI-3a: the presentation is read from the text (`pmiPresentation`): a callout is read when
  // all of it is drawn and it presents an item that matched the file (`verifiedPmi`'s
  // `entityOf`); its occurrences are read with it.
  const linked = presentation ? linkedCallouts(presentation, verifiedPmi(json, semantics)) : [];
  // A relationship between two callouts (`DRAUGHTING_CALLOUT_RELATIONSHIP`, counted with the
  // callouts) is read when both are.
  const ids = new Set(linked.map((l) => l.callout.id));
  const related = (presentation?.relationships ?? []).filter(([a, b]) => ids.has(a) && ids.has(b));
  const callouts = census.callout ?? 0;
  if (callouts || linked.length)
    add('presentation', 'callout', callouts, linked.length + related.length);
  const annotations = census.annotation ?? 0;
  // By entity: callouts can share an occurrence, and the census counts it once.
  const occurrences = new Set(linked.flatMap((l) => l.callout.occurrences)).size;
  if (annotations || occurrences) add('presentation', 'annotation', annotations, occurrences);
  // PMI-3b: a saved view is read from the text when its parallel camera is (`keptView`); the
  // XDE reader's views are counted only without the text's presentation.
  const views = census.view ?? 0;
  const readViews = presentation
    ? presentation.views.filter(keptView).length
    : json.views.filter((v) => v.object).length;
  if (views || readViews) add('view', 'view', views, readViews);
  // Every other family (assembly paths, callouts, unknown PMI) is not checked: never dropped.
  const checked = new Set(axes.map((a) => a.family));
  for (const [family, n] of Object.entries(census) as [CadPmiFamily, number][])
    if (n && !checked.has(family)) add('unsupported', family, n, 0);
  const complete = axes.every((a) => a.unread === 0 && a.read === a.inFile);
  return {
    census,
    read: {
      dimensions: json.dimensions.filter((i) => i.object).length,
      tolerances: json.tolerances.filter((i) => i.object).length,
      datums: distinctDatums(json.datums).filter((i) => i.object).length,
      views: readViews,
    },
    axes,
    kept: noPmiKept(),
    complete,
    lossless: false,
  };
}

/** Matches signatures one to one; returns the matched indices of `read`. */
function matchRead(file: string[], read: string[]): Set<number> {
  const free = new Map<string, number>();
  for (const sig of file) free.set(sig, (free.get(sig) ?? 0) + 1);
  const matched = new Set<number>();
  read.forEach((sig, i) => {
    const n = free.get(sig) ?? 0;
    if (n > 0) {
      free.set(sig, n - 1);
      matched.add(i);
    }
  });
  return matched;
}

/**
 * PMI-3b: whether a saved view can be kept: a parallel camera in a known product frame, and no
 * clipping (this viewer does not clip, so a section view would show what it hides).
 */
export const keptView = (v: PmiFileView) =>
  !!v.camera &&
  v.camera.projection === 'parallel' &&
  !v.camera.clipping &&
  v.frames.length > 0 &&
  v.name.length <= cadPmiLimits.viewName;

/** A callout drawn whole, with the verified items it presents (PMI-3a). */
export interface CadLinkedCallout {
  callout: PmiFileCallout;
  items: PmiItemJson[];
}
/**
 * The callouts of the file drawn whole that present at least one verified item with a file
 * entity of its own (`CadPmiVerified.entityOf`), placed in the product the item is on (a body
 * is kept in its product's frame; lines listed only in another product's frame are not the
 * item's).
 */
export function linkedCallouts(
  presentation: PmiFilePresentation,
  verified: CadPmiVerified,
): CadLinkedCallout[] {
  const itemOf = new Map<number, PmiItemJson>();
  for (const [item, entity] of verified.entityOf) itemOf.set(entity, item);
  return presentation.callouts.flatMap((callout) => {
    if (callout.unsupported) return [];
    const frames = new Set(callout.frames);
    const items = callout.presents.flatMap((e) =>
      frames.has(presentation.itemFrame.get(e) ?? NaN) ? (itemOf.get(e) ?? []) : [],
    );
    return items.length ? [{ callout, items }] : [];
  });
}
/**
 * The vertices `presentationOfItems` would make: each callout's lines once for every item it
 * presents. Counted before copying, as a callout presenting many items repeats its lines.
 */
export function presentedVertices(linked: CadLinkedCallout[]): number {
  return linked.reduce((n, l) => n + (l.callout.segments.length / 3) * l.items.length, 0);
}
/** Each item's presentation from the callouts that present it, their lines joined. */
export function presentationOfItems(
  linked: CadLinkedCallout[],
): Map<PmiItemJson, CadPmiPresentation> {
  const out = new Map<PmiItemJson, CadPmiPresentation>();
  for (const { callout, items } of linked)
    for (const item of items) {
      const p = out.get(item) ?? { segments: [] };
      for (const v of callout.segments) p.segments.push(v);
      if (!p.plane && callout.plane) p.plane = callout.plane;
      out.set(item, p);
    }
  return out;
}

/**
 * PMI-3b: the saved views of each linked item's lines. `ranges` follows `presentationOfItems`:
 * the item's segments, callout by callout, each with the kept views (`keptView`) that list
 * that callout in the frame of the item's product, so a view shows only its own callouts'
 * lines. `views` is their union.
 */
export interface CadItemViews {
  views: PmiFileView[];
  ranges: { end: number; views: PmiFileView[] }[];
}
/**
 * The views of each linked item, or `too-many` when a callout or an item would be in more
 * views than one asset holds (`cadPmiLimits.views`): the memberships are bounded while they
 * are made, so many cameras sharing a model with many items stop early.
 */
export function viewsOfItems(
  presentation: PmiFilePresentation,
  linked: CadLinkedCallout[],
  verified: CadPmiVerified,
): Map<PmiItemJson, CadItemViews> | 'too-many' {
  const linkedIds = new Set(linked.map((l) => l.callout.id));
  // The linked callouts of each list, found once: the views of one model share its list.
  const inList = new Map<number[], number[]>();
  const viewsOfCallout = new Map<number, PmiFileView[]>();
  for (const view of presentation.views.filter(keptView)) {
    let ids = inList.get(view.callouts);
    if (!ids) {
      ids = [...new Set(view.callouts)].filter((id) => linkedIds.has(id));
      inList.set(view.callouts, ids);
    }
    for (const id of ids) {
      const views = viewsOfCallout.get(id) ?? [];
      if (views.length >= cadPmiLimits.views) return 'too-many';
      views.push(view);
      viewsOfCallout.set(id, views);
    }
  }
  const out = new Map<PmiItemJson, CadItemViews & { all: Set<PmiFileView>; end: number }>();
  for (const { callout, items } of linked)
    for (const item of items) {
      const frame = presentation.itemFrame.get(verified.entityOf.get(item) ?? NaN);
      const views = (viewsOfCallout.get(callout.id) ?? []).filter(
        (v) => frame !== undefined && v.frames.includes(frame),
      );
      const o = out.get(item) ?? { views: [], ranges: [], all: new Set(), end: 0 };
      o.end += callout.segments.length;
      o.ranges.push({ end: o.end, views });
      for (const v of views) o.all.add(v);
      if (o.all.size > cadPmiLimits.views) return 'too-many';
      out.set(item, o);
    }
  return new Map(
    [...out]
      .filter(([, o]) => o.all.size > 0)
      .map(([item, o]) => [item, { views: [...o.all], ranges: o.ranges }]),
  );
}

/** The reader's items whose meaning and ends matched the file's, by kind (PMI-2). */
export interface CadPmiVerified {
  dimensions: PmiItemJson[];
  tolerances: PmiItemJson[];
  /** Distinct datums (`distinctDatums`), without datum targets. */
  datums: PmiItemJson[];
  datumTargets: PmiItemJson[];
  /**
   * PMI-3: the file's entity of each verified item whose signature (meaning and ends) is the
   * only one of its kind in the file and among the verified items, so that a presentation the
   * file links to that entity is the item's. Items that share a signature have none: which
   * presentation is whose is not guessed.
   */
  entityOf: Map<PmiItemJson, number>;
}
/**
 * PMI-2: the items the import may keep. An item is verified when it has the reader's object,
 * every target resolves to a product's sub-shape, and its meaning with the number of
 * sub-shapes at each end matches one of the file's items one to one (the target axis of
 * `comparePmi`, which includes the semantic signature).
 */
export function verifiedPmi(json: CadPmiJson, semantics: CadPmiSemantics): CadPmiVerified {
  const byLabel = new Map(json.datums.map((d) => [d.label, d]));
  const onShapes = (i: PmiItemJson) =>
    i.object && i.targets.length > 0 && [...i.targets, ...(i.targets2 ?? [])].every(resolved);
  const located = (d: PmiItemJson) =>
    d.type !== undefined && /^Location_/.test(pmiDimensionTypes[d.type] ?? '');
  const entityOf = new Map<PmiItemJson, number>();
  const pick = (
    items: PmiItemJson[],
    file: string[],
    sig: (i: PmiItemJson) => string,
    entities: number[],
  ) => {
    const candidates = items.filter(onShapes);
    const sigs = candidates.map(sig);
    const matched = matchRead(file, sigs);
    // How often each signature occurs, and where in the file: counted once, not per item.
    const counts = (list: string[]) => {
      const n = new Map<string, number>();
      for (const x of list) n.set(x, (n.get(x) ?? 0) + 1);
      return n;
    };
    const inRead = counts(sigs);
    const inFile = counts(file);
    const firstInFile = new Map<string, number>();
    file.forEach((x, i) => {
      if (!firstInFile.has(x)) firstInFile.set(x, i);
    });
    candidates.forEach((item, i) => {
      if (!matched.has(i) || inRead.get(sigs[i]) !== 1 || inFile.get(sigs[i]) !== 1) return;
      const entity = entities[firstInFile.get(sigs[i])!];
      if (entity !== undefined) entityOf.set(item, entity);
    });
    return candidates.filter((_, i) => matched.has(i));
  };
  return {
    entityOf,
    dimensions: pick(
      json.dimensions,
      semantics.targets.dimension,
      (d) =>
        `${readDimension(d)}|${located(d) ? `${d.targets.length},${d.targets2?.length ?? 0}` : d.targets.length}`,
      semantics.entities.dimension,
    ),
    tolerances: pick(
      json.tolerances,
      semantics.targets['geometric-tolerance'],
      (t) => `${readTolerance(t, byLabel)}|${t.targets.length}`,
      semantics.entities['geometric-tolerance'],
    ),
    datums: pick(
      distinctDatums(json.datums.filter((d) => !d.target)),
      semantics.targets.datum,
      (d) => `${d.name ?? '?'}|${d.targets.length}`,
      semantics.entities.datum,
    ),
    datumTargets: pick(
      distinctDatums(json.datums.filter((d) => d.target)),
      semantics.targets['datum-target'],
      (d) => `${readTarget(d)}|${d.targets.length}`,
      semantics.entities['datum-target'],
    ),
  };
}

/** The datum key `distinctDatums` uses: one datum however many tolerances reference it. */
export const datumKey = (d: PmiItemJson) =>
  JSON.stringify([
    d.name ?? '',
    d.target ?? null,
    d.targets.map((t) => [t.product ?? t.label, t.shape, t.index ?? 0]),
  ]);

/** Whether this build has the PMI helper (PMI-1 kernel). */
export const canReadPmi = (oc: OcModule) =>
  typeof oc.OCJS?.pmiJson === 'function' && typeof oc.STEPCAFControl_Reader_1 === 'function';

/**
 * Reads a STEP file's PMI with the XDE reader in GD&T and view mode, as the helper's JSON. The
 * file is already at `path`; every handle is released before returning.
 */
/** The helper's JSON of an XDE document read in GD&T and view mode. */
export const pmiJsonOf = (oc: OcModule, own: <T>(value: T) => T, doc: unknown): CadPmiJson =>
  JSON.parse(own(oc.OCJS.pmiJson(doc)).ToCString() as string) as CadPmiJson;

export function readPmiJson(oc: OcModule, path: string): CadPmiJson {
  const owned: { delete(): void; isDeleted?(): boolean }[] = [];
  const own = <T>(value: T): T => (owned.push(value as never), value);
  try {
    const reader = own(new oc.STEPCAFControl_Reader_1());
    reader.SetGDTMode(true);
    reader.SetViewMode(true);
    if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
      throw new Error('pmi-read');
    const text = own(new oc.TCollection_ExtendedString_2('MDTV-XCAF', false));
    const doc = own(new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(text)));
    if (!reader.Transfer_1(doc, own(new oc.Message_ProgressRange_1())))
      throw new Error('pmi-transfer');
    return JSON.parse(own(oc.OCJS.pmiJson(doc)).ToCString() as string) as CadPmiJson;
  } finally {
    for (const value of owned.reverse())
      if (value && typeof value.delete === 'function' && !value.isDeleted?.()) value.delete();
  }
}
