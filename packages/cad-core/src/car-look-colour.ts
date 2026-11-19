import { f147Package } from './car-look-detail';
import { fixtureKernel } from './fixtures';
import { presetLook } from './lamp-fixtures';
import type { CadAppearance, CadKernelProfile } from './model';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;

/**
 * CL9b: 「翔」's materials and three colour schemes. Every scheme paints the skin (body halves,
 * nose, tail, the shut panels and the mirror housings) one colour, glazes the canopy as dark
 * glossy glass (there is no interior to see through it), gives the tyres rubber and the floor
 * and ducts dark plastic, and finishes the wheels' faces in its own metal. Lamps and the mirror
 * glass keep CL8b's and CL8d's materials. The package's blocks (driver, engine…) stay inside.
 */
export type F148SchemeId = 'pearl' | 'rosso' | 'ai';
export interface F148Scheme {
  id: F148SchemeId;
  name: string;
  paint: CadAppearance;
  wheel: CadAppearance;
}
export const f148Schemes: readonly F148Scheme[] = Object.freeze([
  {
    id: 'pearl',
    name: '白銀 (pearl white, silver wheels)',
    paint: { ...presetLook('paint-gloss'), color: '#e8e6e0', roughness: 0.16 },
    wheel: { ...presetLook('aluminium'), color: '#d4d7db', roughness: 0.25, metalness: 0.6 },
  },
  {
    id: 'rosso',
    name: '紅 (deep red, gunmetal wheels)',
    paint: { ...presetLook('paint-gloss'), color: '#8e1418', roughness: 0.14 },
    wheel: { ...presetLook('steel'), color: '#5d6168', roughness: 0.3, metalness: 0.7 },
  },
  {
    id: 'ai',
    name: '藍 (indigo metallic, bronze wheels)',
    paint: { ...presetLook('paint-gloss'), color: '#1c2f52', roughness: 0.28, metalness: 0.45 },
    wheel: { ...presetLook('brass'), color: '#a57f45', roughness: 0.3, metalness: 0.7 },
  },
] satisfies F148Scheme[]);

/** Dark glossy glass: reflects, shows nothing behind it. */
export const f148Glass: CadAppearance = Object.freeze({
  ...presetLook('glass'),
  color: '#10151b',
  opacity: 1,
  roughness: 0.03,
});
export const f148Rubber: CadAppearance = Object.freeze({ ...presetLook('rubber') });
export const f148Dark: CadAppearance = Object.freeze({
  ...presetLook('plastic-matte'),
  color: '#16191d',
});

/** Which body of F147 takes which of a scheme's looks (undefined: kept). */
export function f148Role(
  bodyId: string,
): 'paint' | 'glass' | 'rubber' | 'dark' | 'wheel' | undefined {
  if (/^skin-(body|body-left|nose|tail)-body$|^shut-|^mirror-housing-/.test(bodyId)) return 'paint';
  if (/^skin-canopy/.test(bodyId)) return 'glass';
  if (/^(front|rear)-(right|left)-body$/.test(bodyId)) return 'rubber';
  if (/^aero-|duct-(right|left)-body$/.test(bodyId)) return 'dark';
  if (/^wheel-.*-rim-body$/.test(bodyId)) return 'wheel';
  return undefined;
}

/**
 * The package's blocks (occupants, engine, tanks, radiators, luggage) and CL5's envelope block
 * and glass: CL2's and CL5's working bodies, drawn hidden by the demos so far. A placed part
 * shows every body, and the envelope fights with the skin, so the finished car leaves them out.
 */
export const f148Dropped = /^(driver|passenger|engine|gearbox|fuel|radiator|luggage|block-|glass-)/;

/** F147 without the working bodies, its proportions read on the skin and canopy instead. */
export function f148Strip(doc: ReturnType<typeof f147Package>) {
  const bodies = doc.bodies.filter((b) => !f148Dropped.test(b.id));
  const kept = new Set<string>();
  const byId = new Map(doc.features.map((f) => [f.id, f]));
  const keep = (id: string) => {
    if (kept.has(id)) return;
    kept.add(id);
    const f = byId.get(id);
    for (const input of (f && 'inputFeatureIds' in f ? f.inputFeatureIds : []) ?? []) keep(input);
  };
  for (const b of bodies) keep(b.resultFeatureId);
  // Every feature some kept body's history needs, plus any feature no dropped body made.
  const dropped = new Set<string>();
  const collect = (id: string) => {
    if (kept.has(id) || dropped.has(id)) return;
    dropped.add(id);
    const f = byId.get(id);
    for (const input of (f && 'inputFeatureIds' in f ? f.inputFeatureIds : []) ?? [])
      collect(input);
  };
  for (const b of doc.bodies) if (f148Dropped.test(b.id)) collect(b.resultFeatureId);
  const skin = (ids: string[]) => ids.filter((id) => bodies.some((b) => b.id === id));
  return {
    ...doc,
    bodies,
    features: doc.features.filter((f) => !dropped.has(f.id)),
    ...(doc.proportions
      ? {
          proportions: {
            ...doc.proportions,
            body: skin([
              'skin-body-body',
              'skin-body-left-body',
              'skin-nose-body',
              'skin-tail-body',
            ]),
            windows: skin(['skin-canopy-body', 'skin-canopy-left-body']),
          },
        }
      : {}),
  };
}

/** F148: F147 in one of CL9b's colour schemes, without the working bodies. */
export function f148Package(scheme: F148SchemeId = 'pearl', kernel: Kernel = fixtureKernel) {
  const s = f148Schemes.find((x) => x.id === scheme)!;
  const doc = f148Strip(f147Package(kernel));
  const looks = {
    paint: s.paint,
    glass: f148Glass,
    rubber: f148Rubber,
    dark: f148Dark,
    wheel: s.wheel,
  };
  return {
    ...doc,
    bodies: doc.bodies.map((b) => {
      const role = f148Role(b.id);
      return role ? { ...b, appearance: { ...looks[role] } } : b;
    }),
  };
}
