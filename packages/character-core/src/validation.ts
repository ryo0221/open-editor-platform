import { canonicalJson } from '@editor-platform/artifact-core';
import { geometryTextureRoles } from '@editor-platform/geometry-core';
import {
  multiresChunkCorners,
  multiresChunkCount,
  multiresGridSize,
  multiresTopology,
  multiresVertexCount,
  type EpmMesh,
  type MultiresChunk,
} from '@editor-platform/geometry-mesh';
import {
  characterAssetMediaTypes,
  characterJointValueKeys,
  isCharacterJointAngle,
  type CharacterJointValueKey,
  characterLimits,
  characterTolerance,
  CharacterValidationError,
  type CharacterDiagnostic,
  type CharacterDocument,
} from './model';

type Rec = Record<string, unknown>;
const reservedKeys = ['__proto__', 'constructor', 'prototype', 'toJSON'];
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const codePoints = (s: string) => [...s].length;
/** Artifact-scoped stable ID: 1–128 code points, no controls, whitespace edges or reserved keys. */
export const characterId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= characterLimits.idCodePoints &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reservedKeys.includes(v);
const text = (v: unknown): v is string =>
  typeof v === 'string' && codePoints(v) <= characterLimits.nameCodePoints && !/\p{Cc}/u.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tuple = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every(finite);
const tickValue = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Plain JSON data only, depth-limited before any domain traversal. */
function jsonShape(value: unknown): { code: string; path: string } | undefined {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number, path: string): { code: string; path: string } | void {
    if (depth > characterLimits.jsonDepth) return { code: 'json-depth', path };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') return Number.isFinite(v) ? undefined : { code: 'number', path };
    if (typeof v !== 'object' || seen.has(v)) return { code: 'json-value', path };
    const isArray = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (isArray ? Array.prototype : Object.prototype))
      return { code: 'json-value', path };
    seen.add(v);
    for (const key of Reflect.ownKeys(v)) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string' || reservedKeys.includes(key)) return { code: 'json-key', path };
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) return { code: 'json-key', path };
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in d) || !d.enumerable) return { code: 'json-value', path };
      const r = visit(d.value, depth + 1, isArray ? `${path}[${key}]` : `${path}.${key}`);
      if (r) return r;
    }
    if (isArray && Object.keys(v).length !== (v as unknown[]).length)
      return { code: 'json-sparse', path };
    seen.delete(v);
  }
  return visit(value, 0, '$') ?? undefined;
}

/**
 * Strict validation of unknown JSON as a schema 1 character document. Returns every diagnostic
 * with its path; an empty list means the value is a `CharacterDocument`. Nothing is repaired.
 */
export function validateCharacter(value: unknown): CharacterDiagnostic[] {
  const out: CharacterDiagnostic[] = [];
  const add = (code: string, path: string, message = code) => out.push({ code, path, message });
  const shape = jsonShape(value);
  if (shape) {
    add(shape.code, shape.path, 'not plain JSON data');
    return out;
  }
  if (!record(value)) {
    add('character-document', '$');
    return out;
  }
  if (value.schemaVersion !== 1) {
    add('unsupported-schema', '$.schemaVersion', 'only schema 1 is read');
    return out;
  }
  if (new TextEncoder().encode(canonicalJson(value)).length > characterLimits.contentBytes)
    add('content-too-large', '$');
  const keys = (v: Rec, path: string, names: string[], optional: string[] = []) => {
    for (const k of names) if (!Object.hasOwn(v, k)) add('missing-key', `${path}.${k}`);
    for (const k of Object.keys(v))
      if (!names.includes(k) && !optional.includes(k)) add('unknown-key', `${path}.${k}`);
  };
  keys(
    value,
    '$',
    [
      'schemaVersion',
      'units',
      'axes',
      'ticksPerSecond',
      'name',
      'assets',
      'materials',
      'parts',
      'skeletons',
      'skins',
      'morphs',
      'props',
      'actions',
    ],
    ['retiredIds'],
  );
  if (value.units !== 'mm') add('units', '$.units');
  if (value.axes !== 'right-handed-z-up') add('axes', '$.axes');
  if (value.ticksPerSecond !== 240000) add('ticks-per-second', '$.ticksPerSecond');
  if (!text(value.name)) add('name', '$.name');

  const ids = new Map<string, string>(); // id → collection
  const list = (name: string, max: number): Rec[] => {
    const a = value[name];
    if (!Array.isArray(a)) {
      add('array', `$.${name}`);
      return [];
    }
    if (a.length > max) add('limit', `$.${name}`, `more than ${max}`);
    return a.filter((item, i) => {
      if (!record(item)) add('object', `$.${name}[${i}]`);
      return record(item);
    }) as Rec[];
  };
  const claim = (item: Rec, path: string, kind: string) => {
    if (!characterId(item.id)) return add('id', `${path}.id`);
    if (ids.has(item.id)) add('duplicate-id', `${path}.id`);
    else ids.set(item.id, kind);
  };
  const transform = (v: unknown, path: string) => {
    if (!record(v)) return add('transform', path);
    keys(v, path, ['translation', 'rotation', 'scale']);
    if (!tuple(v.translation, 3)) add('vec3', `${path}.translation`);
    if (!tuple(v.rotation, 4)) add('quat', `${path}.rotation`);
    else if (
      Math.abs(Math.hypot(...(v.rotation as number[])) - 1) > characterTolerance.unitQuaternion
    )
      add('unit-quaternion', `${path}.rotation`);
    if (!tuple(v.scale, 3) || (v.scale as number[]).some((s) => s === 0))
      add('scale', `${path}.scale`);
  };

  const assets = list('assets', characterLimits.assets);
  assets.forEach((a, i) => {
    const p = `$.assets[${i}]`;
    keys(a, p, ['id', 'kind', 'sha256', 'byteLength', 'mediaType']);
    claim(a, p, 'asset');
    const kind = a.kind as keyof typeof characterAssetMediaTypes;
    if (typeof kind !== 'string' || !Object.hasOwn(characterAssetMediaTypes, kind))
      add('asset-kind', `${p}.kind`);
    else if (a.mediaType !== characterAssetMediaTypes[kind]) add('media-type', `${p}.mediaType`);
    if (typeof a.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(a.sha256))
      add('sha256', `${p}.sha256`);
    if (
      !Number.isSafeInteger(a.byteLength) ||
      (a.byteLength as number) <= 0 ||
      (a.byteLength as number) > characterLimits.assetBytes
    )
      add('byte-length', `${p}.byteLength`);
  });
  const assetKind = (id: unknown) => assets.find((a) => a.id === id)?.kind;

  const materials = list('materials', characterLimits.materials);
  materials.forEach((m, i) => {
    const p = `$.materials[${i}]`;
    keys(m, p, ['id', 'name', 'color', 'opacity', 'roughness', 'metalness', 'maps', 'doubleSided']);
    claim(m, p, 'material');
    if (!text(m.name)) add('name', `${p}.name`);
    if (typeof m.color !== 'string' || !/^#[0-9a-f]{6}$/.test(m.color)) add('color', `${p}.color`);
    for (const k of ['opacity', 'roughness', 'metalness'])
      if (!finite(m[k]) || (m[k] as number) < 0 || (m[k] as number) > 1)
        add('unit-range', `${p}.${k}`);
    if (typeof m.doubleSided !== 'boolean') add('boolean', `${p}.doubleSided`);
    if (!record(m.maps)) add('maps', `${p}.maps`);
    else
      for (const [role, id] of Object.entries(m.maps)) {
        if (!(geometryTextureRoles as readonly string[]).includes(role))
          add('texture-role', `${p}.maps.${role}`);
        const k = assetKind(id);
        if (k !== 'texture-png' && k !== 'texture-jpeg') add('texture-asset', `${p}.maps.${role}`);
      }
  });

  const parts = list('parts', characterLimits.parts);
  parts.forEach((part, i) => {
    const p = `$.parts[${i}]`;
    keys(
      part,
      p,
      ['id', 'name', 'parentId', 'transform', 'mesh', 'materials', 'visible'],
      ['subdivision', 'multires'],
    );
    if (part.multires !== undefined) {
      const mr = part.multires as Rec;
      if (!record(mr)) add('multires', `${p}.multires`);
      else {
        keys(mr, `${p}.multires`, ['level', 'topology', 'chunks']);
        if (
          !Number.isInteger(mr.level) ||
          (mr.level as number) < 1 ||
          (mr.level as number) > characterLimits.multiresLevels
        )
          add('multires-level', `${p}.multires.level`);
        if (typeof mr.topology !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(mr.topology))
          add('sha256', `${p}.multires.topology`);
        if (
          !Array.isArray(mr.chunks) ||
          mr.chunks.length === 0 ||
          mr.chunks.length > characterLimits.assets
        )
          add('multires-chunks', `${p}.multires.chunks`);
        else
          mr.chunks.forEach((id: unknown, k: number) => {
            if (assetKind(id) !== 'mesh-mres') add('multires-asset', `${p}.multires.chunks[${k}]`);
          });
      }
    }
    if (part.subdivision !== undefined) {
      const sd = part.subdivision as Rec;
      const level = (x: unknown) =>
        Number.isInteger(x) &&
        (x as number) >= 0 &&
        (x as number) <= characterLimits.subdivisionLevels;
      if (!record(sd)) add('subdivision', `${p}.subdivision`);
      else {
        keys(sd, `${p}.subdivision`, ['levels', 'renderLevels']);
        if (!level(sd.levels) || !level(sd.renderLevels)) add('subdivision', `${p}.subdivision`);
      }
    }
    claim(part, p, 'part');
    if (!text(part.name)) add('name', `${p}.name`);
    transform(part.transform, `${p}.transform`);
    if (assetKind(part.mesh) !== 'mesh-epm') add('mesh-asset', `${p}.mesh`);
    if (typeof part.visible !== 'boolean') add('boolean', `${p}.visible`);
    if (!Array.isArray(part.materials) || part.materials.length > characterLimits.materialSlots)
      add('material-slots', `${p}.materials`);
  });
  const skeletons = list('skeletons', characterLimits.skeletons);
  let boneCount = 0;
  const boneOwner = new Map<string, string>();
  skeletons.forEach((s, i) => {
    const p = `$.skeletons[${i}]`;
    keys(s, p, ['id', 'name', 'parentPartId', 'bones'], ['ik']);
    claim(s, p, 'skeleton');
    if (!text(s.name)) add('name', `${p}.name`);
    if (!Array.isArray(s.bones)) return add('array', `${p}.bones`);
    s.bones.forEach((b: unknown, j: number) => {
      const q = `${p}.bones[${j}]`;
      if (!record(b)) return add('object', q);
      keys(b, q, ['id', 'name', 'parentId', 'rest'], ['limits']);
      claim(b, q, 'bone');
      if (characterId(b.id)) boneOwner.set(b.id, s.id as string);
      if (!text(b.name)) add('name', `${q}.name`);
      transform(b.rest, `${q}.rest`);
      if (b.limits !== undefined) {
        const l = b.limits as Rec;
        const angle = (v: unknown) => tuple(v, 3) && v.every((x) => x >= -180 && x <= 180);
        if (!record(l)) add('bone-limits', `${q}.limits`);
        else {
          keys(l, `${q}.limits`, ['min', 'max']);
          if (
            !angle(l.min) ||
            !angle(l.max) ||
            (l.min as number[]).some((x, k) => x > (l.max as number[])[k]!)
          )
            add('bone-limits', `${q}.limits`);
        }
      }
      boneCount++;
    });
  });
  // C5d: IK chains, after every bone is known.
  skeletons.forEach((s, i) => {
    if (s.ik === undefined) return;
    const p = `$.skeletons[${i}].ik`;
    if (!Array.isArray(s.ik) || s.ik.length > characterLimits.ikChains) return add('ik', p);
    s.ik.forEach((c: unknown, j: number) => {
      const q = `${p}[${j}]`;
      if (!record(c)) return add('object', q);
      keys(c, q, ['id', 'name', 'tipBoneId', 'length', 'target', 'pole', 'enabled']);
      claim(c, q, 'ik');
      if (!text(c.name)) add('name', `${q}.name`);
      if (!tuple(c.target, 3)) add('vec3', `${q}.target`);
      if (c.pole !== null && !tuple(c.pole, 3)) add('vec3', `${q}.pole`);
      if (typeof c.enabled !== 'boolean') add('boolean', `${q}.enabled`);
      if (
        !Number.isInteger(c.length) ||
        (c.length as number) < 1 ||
        (c.length as number) > characterLimits.ikChainLength
      )
        return add('ik-chain', `${q}.length`);
      // The tip is a bone of this skeleton with `length` bones above it.
      const bones = Array.isArray(s.bones) ? (s.bones.filter(record) as Rec[]) : [];
      const of = new Map(bones.map((b) => [b.id, b]));
      let at = of.get(c.tipBoneId);
      if (!at) return add('ik-chain', `${q}.tipBoneId`);
      for (let k = 0; k < (c.length as number); k++) {
        at = at.parentId === null ? undefined : of.get(at.parentId);
        if (!at) return add('ik-chain', `${q}.length`);
      }
    });
  });
  if (boneCount > characterLimits.bones)
    add('limit', '$.skeletons', `more than ${characterLimits.bones} bones`);
  const skins = list('skins', characterLimits.parts);
  const morphs = list('morphs', characterLimits.morphs);
  const props = list('props', characterLimits.props);
  const actions = list('actions', characterLimits.actions);
  const bimProps = new Set(
    props.flatMap((p) =>
      record(p) && record(p.source) && p.source.kind === 'bim' && typeof p.id === 'string'
        ? [p.id]
        : [],
    ),
  );
  props.forEach((prop, i) => {
    const p = `$.props[${i}]`;
    keys(prop, p, ['id', 'name', 'source', 'placement', 'visible']);
    claim(prop, p, 'prop');
    if (!text(prop.name)) add('name', `${p}.name`);
    if (typeof prop.visible !== 'boolean') add('boolean', `${p}.visible`);
    const s = prop.source;
    if (!record(s)) add('prop-source', `${p}.source`);
    else {
      keys(s, `${p}.source`, ['kind', 'artifactId', 'versionId', 'contentHash']);
      if (
        (s.kind !== 'cad' && s.kind !== 'bim') ||
        !characterId(s.artifactId) ||
        !characterId(s.versionId) ||
        typeof s.contentHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(s.contentHash)
      )
        add('prop-source', `${p}.source`);
    }
    const at = prop.placement;
    if (!record(at)) add('placement', `${p}.placement`);
    else {
      keys(at, `${p}.placement`, ['translation', 'rotation']);
      if (!tuple(at.translation, 3)) add('vec3', `${p}.placement.translation`);
      if (!tuple(at.rotation, 4)) add('quat', `${p}.placement.rotation`);
      else if (
        Math.abs(Math.hypot(...(at.rotation as number[])) - 1) > characterTolerance.unitQuaternion
      )
        add('unit-quaternion', `${p}.placement.rotation`);
    }
  });
  skins.forEach((s, i) => keys(s, `$.skins[${i}]`, ['id', 'partId', 'skeletonId', 'inverseBind']));
  morphs.forEach((m, i) => keys(m, `$.morphs[${i}]`, ['id', 'partId', 'name', 'weight']));
  skins.forEach((s, i) => claim(s, `$.skins[${i}]`, 'skin'));
  morphs.forEach((m, i) => claim(m, `$.morphs[${i}]`, 'morph'));
  const kindOf = (id: unknown) => (typeof id === 'string' ? ids.get(id) : undefined);

  // References, after every ID is known.
  parts.forEach((part, i) => {
    const p = `$.parts[${i}]`;
    if (part.parentId !== null && kindOf(part.parentId) !== 'part') add('parent', `${p}.parentId`);
    if (Array.isArray(part.materials))
      part.materials.forEach((m: unknown, j: number) => {
        if (kindOf(m) !== 'material') add('material', `${p}.materials[${j}]`);
      });
  });
  const cycle = (items: Rec[], path: (i: number) => string) => {
    const parent = new Map(items.map((x) => [x.id, x.parentId]));
    items.forEach((x, i) => {
      const seen = new Set<unknown>();
      let at: unknown = x.id;
      while (at !== null && at !== undefined) {
        if (seen.has(at)) return add('cycle', path(i));
        seen.add(at);
        at = parent.get(at);
      }
    });
  };
  cycle(parts, (i) => `$.parts[${i}].parentId`);
  skeletons.forEach((s, i) => {
    const p = `$.skeletons[${i}]`;
    if (s.parentPartId !== null && kindOf(s.parentPartId) !== 'part')
      add('parent', `${p}.parentPartId`);
    if (!Array.isArray(s.bones)) return;
    const bones = s.bones.filter(record) as Rec[];
    bones.forEach((b, j) => {
      if (b.parentId !== null && boneOwner.get(b.parentId as string) !== s.id)
        add('parent', `${p}.bones[${j}].parentId`);
    });
    cycle(bones, (j) => `${p}.bones[${j}].parentId`);
  });
  const skinned = new Set<unknown>();
  skins.forEach((s, i) => {
    const p = `$.skins[${i}]`;
    if (kindOf(s.partId) !== 'part') add('part', `${p}.partId`);
    else if (skinned.has(s.partId)) add('duplicate-skin', `${p}.partId`);
    skinned.add(s.partId);
    if (kindOf(s.skeletonId) !== 'skeleton') add('skeleton', `${p}.skeletonId`);
    if (!Array.isArray(s.inverseBind)) return add('array', `${p}.inverseBind`);
    const seen = new Set<unknown>();
    s.inverseBind.forEach((e: unknown, j: number) => {
      const q = `${p}.inverseBind[${j}]`;
      if (!record(e)) return add('object', q);
      keys(e, q, ['boneId', 'matrix']);
      if (boneOwner.get(e.boneId as string) !== s.skeletonId) add('bone', `${q}.boneId`);
      if (seen.has(e.boneId)) add('duplicate-bone', `${q}.boneId`);
      seen.add(e.boneId);
      if (!tuple(e.matrix, 16)) add('matrix', `${q}.matrix`);
    });
  });
  morphs.forEach((m, i) => {
    const p = `$.morphs[${i}]`;
    if (kindOf(m.partId) !== 'part') add('part', `${p}.partId`);
    if (!text(m.name)) add('name', `${p}.name`);
    if (!finite(m.weight) || Math.abs(m.weight as number) > characterLimits.morphWeight)
      add('weight', `${p}.weight`);
  });
  actions.forEach((a, i) => {
    const p = `$.actions[${i}]`;
    keys(a, p, ['id', 'name', 'duration', 'frameRate', 'tracks']);
    claim(a, p, 'action');
    if (!text(a.name)) add('name', `${p}.name`);
    const duration = a.duration;
    if (
      !tickValue(duration) ||
      duration === 0 ||
      (duration as number) > characterLimits.durationTicks
    )
      add('duration', `${p}.duration`);
    const fr = a.frameRate;
    if (
      !record(fr) ||
      Object.keys(fr).length !== 2 ||
      !Number.isSafeInteger(fr.numerator) ||
      !Number.isSafeInteger(fr.denominator) ||
      (fr.numerator as number) <= 0 ||
      (fr.denominator as number) <= 0
    )
      add('frame-rate', `${p}.frameRate`);
    if (!Array.isArray(a.tracks)) return add('array', `${p}.tracks`);
    if (a.tracks.length > characterLimits.tracksPerAction) add('limit', `${p}.tracks`);
    const targets = new Set<string>();
    a.tracks.forEach((t: unknown, j: number) => {
      const q = `${p}.tracks[${j}]`;
      if (!record(t)) return add('object', q);
      keys(t, q, ['id', 'target', 'keys']);
      claim(t, q, 'track');
      const target = t.target;
      let size = 0;
      if (!record(target)) add('target', `${q}.target`);
      else {
        const k = target.kind,
          prop = target.property;
        keys(
          target,
          `${q}.target`,
          k === 'prop-joint'
            ? ['kind', 'id', 'joint', 'property']
            : k === 'prop-mount'
              ? ['kind', 'id', 'mount', 'property']
              : k === 'camera'
                ? ['kind', 'property']
                : ['kind', 'id', 'property'],
        );
        if (
          (k === 'part' || k === 'bone') &&
          ['translation', 'rotation', 'scale'].includes(prop as string)
        )
          size = prop === 'rotation' ? 4 : 3;
        else if (k === 'morph' && prop === 'weight') size = 1;
        else if (k === 'prop' && (prop === 'translation' || prop === 'rotation'))
          size = prop === 'rotation' ? 4 : 3;
        else if (
          k === 'prop-joint' &&
          (characterJointValueKeys as readonly unknown[]).includes(prop) &&
          characterId(target.joint)
        )
          size = 1;
        // MR7: a mount's joint in effect, a joint ID per key.
        else if (k === 'prop-mount' && prop === 'joint' && characterId(target.mount)) size = -1;
        // CR7e: the action's camera has no element to name.
        else if (k === 'camera' && (prop === 'position' || prop === 'target')) size = 3;
        else add('target', `${q}.target`);
        const ofProp = k === 'prop-joint' || k === 'prop-mount';
        if (size && k !== 'camera' && kindOf(target.id) !== (ofProp ? 'prop' : k))
          add('target-id', `${q}.target.id`);
        // C8p: a building's elements have no joints to key.
        else if (size && ofProp && bimProps.has(target.id as string))
          add('prop-joint-unsupported', `${q}.target`);
        else if (size) {
          // Only a well-formed target names a channel; others are already reported above.
          const key = JSON.stringify([k, target.id, target.joint ?? target.mount ?? null, prop]);
          if (targets.has(key)) add('duplicate-target', `${q}.target`);
          targets.add(key);
        }
      }
      if (!Array.isArray(t.keys) || t.keys.length === 0) return add('keys', `${q}.keys`);
      if (t.keys.length > characterLimits.keysPerTrack) add('limit', `${q}.keys`);
      let last = -1;
      t.keys.forEach((key: unknown, n: number) => {
        const r = `${q}.keys[${n}]`;
        if (!record(key)) return add('object', r);
        keys(key, r, ['id', 'tick', 'value', 'easing']);
        claim(key, r, 'key');
        if (!tickValue(key.tick) || (tickValue(duration) && (key.tick as number) > duration))
          add('tick', `${r}.tick`);
        else if ((key.tick as number) <= last) add('key-order', `${r}.tick`);
        else last = key.tick as number;
        if (
          size === -1
            ? !characterId(key.value)
            : size === 1
              ? !finite(key.value)
              : size && !tuple(key.value, size)
        )
          add('value', `${r}.value`);
        // MR7: a mount key holds its joint until the next key; it never blends.
        else if (size === -1 && (!record(key.easing) || key.easing.type !== 'hold'))
          add('mount-easing', `${r}.easing`);
        // A keyed morph weight has the same bound as the weight used without an action.
        else if (
          record(target) &&
          target.kind === 'morph' &&
          Math.abs(key.value as number) > characterLimits.morphWeight
        )
          add('weight', `${r}.value`);
        else if (
          record(target) &&
          target.kind === 'prop-joint' &&
          Math.abs(key.value as number) >
            (isCharacterJointAngle(target.property as CharacterJointValueKey)
              ? characterLimits.jointTurnRad
              : characterLimits.jointTravelMm)
        )
          // WM2: a CAD continuous joint turns on and on; a joint that keeps one turn bounds its
          // keys through its version's limits (one turn either way).
          add('joint-value', `${r}.value`);
        else if (
          record(target) &&
          target.kind === 'camera' &&
          size === 3 &&
          (key.value as number[]).some((x) => Math.abs(x) > characterLimits.cameraRangeMm)
        )
          add('camera-range', `${r}.value`);
        else if (
          size === 4 &&
          Math.abs(Math.hypot(...(key.value as number[])) - 1) > characterTolerance.unitQuaternion
        )
          add('unit-quaternion', `${r}.value`);
        if (!easing(key.easing)) add('easing', `${r}.easing`);
      });
    });
  });
  if (Object.hasOwn(value, 'retiredIds')) {
    const retired = value.retiredIds;
    if (!Array.isArray(retired)) add('array', '$.retiredIds');
    else {
      if (retired.length > characterLimits.retiredIds)
        add('limit', '$.retiredIds', `more than ${characterLimits.retiredIds}`);
      const seen = new Set<string>();
      retired.forEach((id, i) => {
        if (!characterId(id)) add('id', `$.retiredIds[${i}]`);
        else if (seen.has(id)) add('duplicate-id', `$.retiredIds[${i}]`);
        else if (ids.has(id)) add('retired-id', `$.retiredIds[${i}]`, 'an element still uses it');
        else seen.add(id as string);
      });
    }
  }
  return out;
}
function easing(e: unknown): boolean {
  if (!record(e)) return false;
  if (e.type === 'hold' || e.type === 'linear') return Object.keys(e).length === 1;
  if (e.type !== 'bezier' || Object.keys(e).length !== 5) return false;
  return (
    (['x1', 'y1', 'x2', 'y2'] as const).every((k) => finite(e[k])) &&
    [e.x1, e.x2].every((x) => (x as number) >= 0 && (x as number) <= 1) &&
    [e.y1, e.y2].every((y) => Math.abs(y as number) <= 4)
  );
}

export const isCharacterDocument = (value: unknown): value is CharacterDocument =>
  validateCharacter(value).length === 0;
/** Throws `CharacterValidationError` with every diagnostic. */
export function assertCharacterDocument(value: unknown): asserts value is CharacterDocument {
  const d = validateCharacter(value);
  if (d.length) throw new CharacterValidationError(d);
}

/**
 * The checks that need the decoded mesh assets: every part's slots cover its faces, every bone a
 * skin's mesh weights names has an inverse bind in that skin, and a part's morphs are exactly its
 * mesh's. `meshes` maps asset IDs to decoded meshes (a missing one is reported). With
 * `multires` (decoded chunks by asset ID), each part's multires chunks are checked too.
 */
export function checkCharacterMeshes(
  doc: CharacterDocument,
  meshes: ReadonlyMap<string, EpmMesh>,
  multires?: ReadonlyMap<string, MultiresChunk>,
): CharacterDiagnostic[] {
  const out: CharacterDiagnostic[] = [];
  const add = (code: string, path: string) => out.push({ code, path, message: code });
  let multiresVertices = 0;
  doc.parts.forEach((part, i) => {
    const p = `$.parts[${i}]`;
    const mesh = meshes.get(part.mesh);
    if (!mesh) return add('mesh-missing', `${p}.mesh`);
    if (part.multires) {
      // C7a: the grids hang from the cage's faces, chunk after chunk in corner order.
      const mr = part.multires;
      const corners = mesh.faceIndices.length;
      if (multiresTopology(mesh) !== mr.topology) add('multires-topology', `${p}.multires`);
      else if (mr.chunks.length !== multiresChunkCount(corners, mr.level))
        add('multires-chunks', `${p}.multires.chunks`);
      else {
        const per = multiresChunkCorners(mr.level);
        const G = multiresGridSize(mr.level);
        // Without the chunks (a caller that only reads the cage) only their count is checked.
        mr.chunks.forEach((id, k) => {
          if (!multires) return;
          const chunk = multires.get(id);
          if (!chunk) return add('multires-missing', `${p}.multires.chunks[${k}]`);
          const n = Math.min(per, corners - k * per);
          if (
            chunk.level !== mr.level ||
            chunk.firstCorner !== k * per ||
            chunk.displacements.length !== 3 * n * G * G
          )
            add('multires-chunk', `${p}.multires.chunks[${k}]`);
        });
        try {
          const v = multiresVertexCount(mesh, mr.level);
          multiresVertices += v;
          if (v > characterLimits.multiresVertices) add('multires-vertices', `${p}.multires`);
        } catch {
          add('multires-topology', `${p}.multires`);
        }
      }
    }
    let slots = 0;
    for (const s of mesh.faceMaterials) slots = Math.max(slots, s + 1);
    if (slots > part.materials.length) add('material-slots', `${p}.materials`);
    const skin = doc.skins.find((s) => s.partId === part.id);
    if (mesh.weights && !skin) add('skin-missing', p);
    if (skin) {
      const bound = new Set(skin.inverseBind.map((e) => e.boneId));
      if (!mesh.weights) add('skin-without-weights', p);
      for (const b of mesh.boneIds) if (!bound.has(b)) add('skin-bone', `${p}.mesh`);
    }
    const morphs = doc.morphs.filter((m) => m.partId === part.id).map((m) => m.id);
    const own = mesh.morphs.map((m) => m.id);
    if (morphs.length !== own.length || morphs.some((m, k) => m !== own[k]))
      add('morph-mismatch', `${p}.mesh`);
  });
  if (multiresVertices > characterLimits.multiresDocumentVertices)
    add('multires-vertices', '$.parts');
  return out;
}
