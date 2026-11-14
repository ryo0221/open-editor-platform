import { describe, expect, it } from 'vitest';
import {
  applyPcbOperation,
  assertPcb,
  generateFootprint,
  pcbDefaultNetClass,
  pcbImportNetList,
  PcbNetListError,
  pcbPadNets,
  pcbParsePin,
  pcbRatsnest,
  pcbStarter,
  validatePcb,
  type PcbComponent,
  type PcbDocument,
  type PcbNet,
} from './index';

const codes = (v: unknown) => validatePcb(v).map((d) => d.code);
const part = (id: string, ref: string, footprint: string, at: [number, number]): PcbComponent => ({
  id,
  ref,
  value: '',
  footprint,
  at,
  rotationDeg: 0,
  side: 'top',
  locked: false,
});
/** A header J1 at the origin-ish and three 0603 resistors. */
function board(nets: PcbNet[] = []): PcbDocument {
  return {
    ...pcbStarter(),
    footprints: [generateFootprint('h', 'pin-header'), generateFootprint('r', 'chip')],
    components: [
      part('j1', 'J1', 'h', [10, 70]),
      part('r1', 'R1', 'r', [10, 10]),
      part('r2', 'R2', 'r', [20, 10]),
      part('r3', 'R3', 'r', [15, 30]),
    ],
    nets,
  };
}
const net = (id: string, name: string, pins: [string, string][]): PcbNet => ({
  id,
  name,
  class: 'nc-default',
  pins,
});
let n = 0;
const newId = () => `net-${++n}`;

describe('PB3 nets and ratsnest (ST-462, TS-1925)', () => {
  it('accepts nets of placed pads and refuses broken ones by code', () => {
    const ok = board([
      net('n1', 'GND', [
        ['j1', '6'],
        ['r1', '2'],
      ]),
    ]);
    expect(validatePcb(ok)).toEqual([]);
    expect(codes(board([net('n1', 'GND', [['j1', '41']])]))).toEqual(['net-pin-missing']);
    expect(codes(board([net('n1', 'GND', [['zz', '1']])]))).toEqual(['net-pin-missing']);
    expect(
      codes(board([net('n1', 'GND', [['r1', '1']]), net('n2', '3V3', [['r1', '1']])])),
    ).toEqual(['net-pin-duplicate']);
    expect(codes(board([net('n1', 'GND', []), net('n2', 'GND', [])]))).toEqual([
      'net-name-duplicate',
    ]);
    expect(codes(board([net('n1', ' GND', [])]))).toEqual(['name']);
    expect(codes(board([{ ...net('n1', 'GND', []), class: 'nope' }]))).toEqual([
      'reference-missing',
    ]);
    expect(codes({ ...board(), netClasses: [] })).toEqual(['net-class-none']);
    expect(
      codes({
        ...board(),
        netClasses: [pcbDefaultNetClass(), { ...pcbDefaultNetClass(), id: 'nc-2' }],
      }),
    ).toEqual(['net-class-name-duplicate']);
    // An unplated hole is no pin.
    const rj = {
      ...board(),
      footprints: [...board().footprints, generateFootprint('rj', 'rj45')],
      components: [...board().components, part('j2', 'J2', 'rj', [50, 40])],
    };
    const npth = generateFootprint('rj', 'rj45').pads.find((p) => p.type === 'npth')!.number;
    expect(codes({ ...rj, nets: [net('n1', 'GND', [['j2', npth]])] })).toEqual(['net-pin-missing']);
    expect(pcbParsePin(rj, `J2.${npth}`)).toBeUndefined();
    expect(
      codes({ ...board(), netClasses: [{ ...pcbDefaultNetClass(), viaDrillMm: 0.6 }] }),
    ).toEqual(['via-drill']);
    expect(
      codes({ ...board(), netClasses: [{ ...pcbDefaultNetClass(), trackWidthMm: 0.01 }] }),
    ).toEqual(['dimension']);
  });

  it('joins each net with its shortest tree of lines', () => {
    const doc = board([
      net('n1', 'GND', [
        ['r1', '1'],
        ['r2', '1'],
        ['r3', '1'],
      ]),
      net('n2', 'LONE', [['j1', '1']]),
    ]);
    const lines = pcbRatsnest(doc);
    expect(lines.map((l) => [l.a.ref, l.b.ref])).toEqual([
      ['R1', 'R2'],
      ['R1', 'R3'],
    ]);
    expect(lines[0].a.at).toEqual([9.2, 10]);
    expect(pcbPadNets(doc).get('r2\u00001')).toBe('n1');
  });

  it('drops a deleted part from its nets and keeps a class in use', () => {
    const doc = board([
      net('n1', 'GND', [
        ['r1', '1'],
        ['r2', '1'],
      ]),
    ]);
    const after = applyPcbOperation(doc, { type: 'delete', ids: ['r2'] });
    expect(after.nets[0].pins).toEqual([['r1', '1']]);
    expect(() => applyPcbOperation(doc, { type: 'delete', ids: ['nc-default'] })).toThrow('in-use');
  });

  it('imports a net list by references, replacing nets of the same name', () => {
    const doc = board([
      net('n1', 'GND', [['r1', '1']]),
      net('n2', 'SDA', [
        ['j1', '3'],
        ['r3', '2'],
      ]),
    ]);
    expect(pcbParsePin(doc, 'J1.40')).toEqual(['j1', '40']);
    expect(pcbParsePin(doc, 'J1.41')).toBeUndefined();
    // Dots in refs and pad numbers: one match wins, two are refused.
    const dotted: PcbDocument = {
      ...doc,
      footprints: [
        ...doc.footprints,
        {
          ...generateFootprint('d', 'chip'),
          pads: generateFootprint('d', 'chip').pads.map((p, i) => ({
            ...p,
            number: i ? 'A.2' : '1',
          })),
        },
      ],
      components: [...doc.components, part('x', 'X', 'd', [60, 60])],
    };
    expect(pcbParsePin(dotted, 'X.A.2')).toEqual(['x', 'A.2']);
    const clash = {
      ...dotted,
      footprints: [...dotted.footprints, generateFootprint('h2', 'pin-header')],
      components: [...dotted.components, part('xa', 'X.A', 'h2', [60, 20])],
    };
    expect(pcbParsePin(clash, 'X.A.2')).toBeUndefined();
    // Pad numbers keep no list separators, so `REF.PAD, REF.PAD` text always splits right.
    for (const bad of ['1,R1.2', 'A 1'])
      expect(() =>
        assertPcb({
          ...dotted,
          footprints: dotted.footprints.map((f) =>
            f.id === 'd'
              ? { ...f, pads: f.pads.map((p, i) => (i ? p : { ...p, number: bad })) }
              : f,
          ),
        }),
      ).toThrow(/pad-number/);
    const nets = pcbImportNetList(
      doc,
      JSON.stringify({
        nets: [
          { name: 'GND', pins: ['J1.6', 'R2.2'] },
          { name: '3V3', class: 'Default', pins: ['J1.1', 'R3.2'] },
        ],
      }),
      newId,
    );
    expect(nets).toEqual([
      net('n1', 'GND', [
        ['j1', '6'],
        ['r2', '2'],
      ]),
      net('n2', 'SDA', [['j1', '3']]),
      net('net-1', '3V3', [
        ['j1', '1'],
        ['r3', '2'],
      ]),
    ]);
    expect(validatePcb(applyPcbOperation(doc, { type: 'setNets', nets }))).toEqual([]);
    const fail = (text: string) => {
      try {
        pcbImportNetList(doc, text, newId);
      } catch (e) {
        return e instanceof PcbNetListError ? `${e.code}@${e.path}` : String(e);
      }
      return 'ok';
    };
    expect(fail('{')).toBe('json@$');
    expect(fail('{"nets":[{"name":"A","pins":["Q9.1"]}]}')).toBe(
      'net-pin-missing@$.nets[0].pins[0]',
    );
    expect(fail('{"nets":[{"name":"A","class":"Power","pins":[]}]}')).toBe(
      'net-class-missing@$.nets[0].class',
    );
    expect(fail('{"nets":[{"name":"A","pins":[]},{"name":"A","pins":[]}]}')).toBe(
      'net-name-duplicate@$.nets[1].name',
    );
    expect(fail('{"nets":[{"name":"A","colour":1,"pins":[]}]}')).toBe(
      'unknown-key@$.nets[0].colour',
    );
    // Two imported nets claiming one pad: the import is refused as a whole by the operation.
    const twice = pcbImportNetList(
      doc,
      '{"nets":[{"name":"A","pins":["R1.1"]},{"name":"B","pins":["R1.1"]}]}',
      newId,
    );
    expect(() => applyPcbOperation(doc, { type: 'setNets', nets: twice })).toThrow(
      'net-pin-duplicate',
    );
  });
});
