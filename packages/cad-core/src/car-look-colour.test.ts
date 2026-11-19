import { describe, expect, it } from 'vitest';
import { f147Package } from './car-look-detail';
import { f148Dropped, f148Glass, f148Package, f148Role, f148Schemes } from './car-look-colour';
import { validateCad } from './validation';

describe('F148: 「翔」 in three colour schemes (CL9b, TS-2036)', () => {
  it('names a role for every outer part, and keeps lamps, mirror glass and the package blocks', () => {
    const doc = f147Package();
    const roles = new Map(doc.bodies.map((b) => [b.name, f148Role(b.id)]));
    for (const n of [
      'Body right',
      'Body left',
      'Nose',
      'Tail',
      'Door right',
      'Hood left',
      'Engine cover right',
      'Mirror housing left',
    ])
      expect(roles.get(n), n).toBe('paint');
    expect(roles.get('Canopy right')).toBe('glass');
    expect(roles.get('Canopy left')).toBe('glass');
    for (const n of ['Front right wheel', 'Rear left wheel'])
      expect(roles.get(n), n).toBe('rubber');
    for (const n of ['Floor', 'Tunnel left', 'Nose inlet duct right', 'Intake duct left'])
      expect(roles.get(n), n).toBe('dark');
    for (const n of ['Front right rim', 'Rear left rim']) expect(roles.get(n), n).toBe('wheel');
    for (const n of [
      'Headlamp lens right',
      'Tail lamp light',
      'Mirror glass right',
      'Engine',
      'Driver head',
    ])
      expect(roles.get(n), n).toBeUndefined();
  });
  it('makes three distinct schemes, each validating with F147’s bodies and shapes', () => {
    const base = f147Package();
    expect(new Set(f148Schemes.map((s) => s.paint.color)).size).toBe(3);
    expect(new Set(f148Schemes.map((s) => s.wheel.color)).size).toBe(3);
    for (const s of f148Schemes) {
      const doc = f148Package(s.id);
      expect(validateCad(doc), s.id).toEqual([]);
      // Only the working bodies (and the features only they need) leave; no skin feature changes.
      expect(doc.bodies.map((b) => b.id)).toEqual(
        base.bodies.filter((b) => !f148Dropped.test(b.id)).map((b) => b.id),
      );
      expect(doc.bodies.some((b) => /^(Driver|Engine$|Block C)/.test(b.name))).toBe(false);
      for (const f of doc.features) expect(base.features).toContainEqual(f);
      expect(doc.features.length).toBeLessThan(base.features.length);
      expect(doc.proportions!.body).toContain('skin-nose-body');
      expect(doc.proportions!.windows).toEqual(['skin-canopy-body', 'skin-canopy-left-body']);
      const look = (name: string) => doc.bodies.find((b) => b.name === name)!.appearance!;
      expect(look('Door left').color).toBe(s.paint.color);
      expect(look('Front left rim').color).toBe(s.wheel.color);
      expect(look('Canopy right')).toEqual(f148Glass);
      expect(look('Tail lamp lens').material).toBe('lamp-lens');
    }
  }, 60_000);
});
