import { describe, expect, it } from 'vitest';
import {
  applyPcbOperation,
  componentPads,
  f75Pi5Board,
  f76HatBoard,
  f76HatEeprom,
  hatEepromCrc16,
  hatEepromImage,
  hatEepromSettings,
  hatHoleCentres,
  PcbHatEepromError,
  pcbDrc,
  pcbFabricationFiles,
  pcbGpioPin,
  pcbHatProblems,
  pcbRatsnest,
  readHatEepromImage,
  validatePcb,
  type PcbDocument,
} from './index';

// PB8a (docs/cad/pcb-design.md, ST-470): F76, an original HAT+ from its net list to fabrication
// data. TS-1951 board, TS-1952 four holes, TS-1953 HAT+ rules, TS-1954 EEPROM image, TS-1955
// stacked boards in the document.

const codes = (v: unknown) => validatePcb(v).map((d) => `${d.code}@${d.path}`);

describe('F76 HAT+ (PB8a)', () => {
  it('TS-1951: is a valid board, every net routed, DRC clean, with fabrication files', () => {
    const doc = f76HatBoard();
    expect(codes(doc)).toEqual([]);
    expect(pcbRatsnest(doc)).toEqual([]);
    expect(pcbDrc(doc).violations).toEqual([]);
    // 65 × 56 mm, the display cut-out in the left edge and the camera slot through the board.
    expect(doc.board.cutouts).toHaveLength(1);
    // Pin 1 of the socket under the board sits over the Pi's pin 1; pin 2 on the edge row.
    const j1 = doc.components.find((c) => c.id === 'j1')!;
    expect(j1.side).toBe('bottom');
    const pads = new Map(componentPads(doc, j1).map((p) => [p.pad.number, p.at]));
    for (const n of [1, 2, 27, 28, 39, 40]) expect(pads.get(String(n))).toEqual(pcbGpioPin(n));
    expect(pcbGpioPin(1)).toEqual([8.37, 51.23]);
    expect(pcbGpioPin(40)).toEqual([56.63, 53.77]);
    // The header's centre is the Pi's: x 32.5, y 52.5.
    expect((pcbGpioPin(1)[0] + pcbGpioPin(40)[0]) / 2).toBeCloseTo(32.5, 9);
    const files = pcbFabricationFiles(doc, 'f76').map((f) => f.name);
    expect(files).toEqual(
      expect.arrayContaining(['f76-F_Cu.gbr', 'f76-B_Cu.gbr', 'f76-Edge_Cuts.gbr']),
    );
    expect(files.some((n) => n.endsWith('.drl'))).toBe(true);
  });

  it('TS-1952: has the four mounting holes, Ø2.75 ± 0.05 mm, aligned with F75 within 0.05 mm', () => {
    const hat = f76HatBoard();
    const pi = f75Pi5Board();
    expect(hat.holes).toHaveLength(4);
    for (const c of hatHoleCentres) {
      const h = hat.holes.find((x) => Math.hypot(x.at[0] - c[0], x.at[1] - c[1]) <= 0.05);
      expect(h, `hole at ${c}`).toBeDefined();
      expect(Math.abs(h!.drillMm - 2.75)).toBeLessThanOrEqual(0.05);
      expect(h!.plated).toBe(false);
      // Stacked over F75 with origins together: each HAT hole over a Pi hole.
      const under = pi.holes.map((p) => Math.hypot(p.at[0] - h!.at[0], p.at[1] - h!.at[1]));
      expect(Math.min(...under)).toBeLessThanOrEqual(0.05);
    }
    expect(pcbHatProblems(hat)).toEqual([]);
    // A hole moved by 0.06 mm, or Ø2.85, or plated, is caught.
    const moved = structuredClone(hat);
    moved.holes[2]!.at = [61.56, 52.5];
    expect(pcbHatProblems(moved).map((p) => p.code)).toEqual(['hat-hole-missing']);
    const wide = structuredClone(hat);
    wide.holes[0]!.drillMm = 2.85;
    wide.holes[1]!.plated = true;
    expect(pcbHatProblems(wide).map((p) => [p.code, p.ids])).toEqual([
      ['hat-hole-size', ['mh-1']],
      ['hat-hole-plated', ['mh-2']],
    ]);
  });

  it('TS-1953: checks the ID pins, the EEPROM supply and back-powering', () => {
    const hat = f76HatBoard();
    const with_ = (change: (d: PcbDocument) => void) => {
      const d = structuredClone(hat);
      change(d);
      return pcbHatProblems(d).map((p) => p.code);
    };
    // Something else on ID_SD (the LED's resistor).
    expect(
      with_((d) => {
        d.nets.find((n) => n.name === 'GPIO17')!.pins = [['j1', '11']];
        d.nets.find((n) => n.name === 'ID_SD')!.pins.push(['u2', '4']);
      }),
    ).toEqual(['hat-id-pin-use']);
    // Another header pin (GPIO21, otherwise unused) on ID_SD.
    expect(
      with_((d) => {
        d.nets.find((n) => n.name === 'ID_SD')!.pins.push(['j1', '40']);
      }),
    ).toEqual(['hat-id-pin-use']);
    // ID_SC's pull-up removed.
    expect(
      with_((d) => {
        const n = d.nets.find((x) => x.name === 'ID_SC')!;
        n.pins = n.pins.filter(([c]) => c !== 'r2');
      }),
    ).toEqual(['hat-id-pullup']);
    // The EEPROM powered from somewhere else.
    expect(
      with_((d) => {
        const n = d.nets.find((x) => x.name === '3V3')!;
        n.pins = n.pins.filter(([c, p]) => !(c === 'u1' && p === '8'));
      }),
    ).toEqual(['hat-eeprom-power']);
    // A net on the 5V pins that reaches a part, or has copper, back-powers the Pi.
    expect(
      with_((d) => {
        d.nets.push({
          id: 'n-5v',
          name: '5V',
          class: 'nc-power',
          pins: [
            ['j1', '2'],
            ['j1', '4'],
          ],
        });
      }),
    ).toEqual([]);
    expect(
      with_((d) => {
        d.nets.push({
          id: 'n-5v',
          name: '5V',
          class: 'nc-power',
          pins: [
            ['j1', '2'],
            ['tp1', '1'],
          ],
        });
        d.nets.find((n) => n.name === 'EEPROM_WP')!.pins.pop();
      }),
    ).toEqual(['hat-back-power']);
    // Without the header, or with it turned, nothing else is checked.
    expect(with_((d) => (d.components[0]!.rotationDeg = 180))).toEqual(['hat-header-missing']);
  });
});

describe('HAT+ EEPROM image (PB8a)', () => {
  it('TS-1954: writes the eeptools HAT+ format with CRC-16 per atom, and reads it back', () => {
    // The CRC is CRC-16/ARC: its check value.
    expect(hatEepromCrc16(new TextEncoder().encode('123456789'))).toBe(0xbb3d);
    const spec = { ...f76HatEeprom(), dtOverlay: 'f76-sensor' };
    const bytes = hatEepromImage(spec);
    const view = new DataView(bytes.buffer);
    expect([...bytes.subarray(0, 4)]).toEqual([0x52, 0x2d, 0x50, 0x69]); // "R-Pi"
    expect(bytes[4]).toBe(2); // HAT+ format
    expect(view.getUint16(6, true)).toBe(2); // vendor and DT atoms
    expect(view.getUint32(8, true)).toBe(bytes.length);
    // Vendor atom: type 1, index 0, data + CRC length; UUID least significant word first.
    expect(view.getUint16(12, true)).toBe(1);
    expect(view.getUint16(14, true)).toBe(0);
    const vendor = 'Editor Platform example';
    const product = 'Sensor HAT+ (F76)';
    expect(view.getUint32(16, true)).toBe(22 + vendor.length + product.length + 2);
    expect(view.getUint32(20, true)).toBe(0x4e6f8a10);
    expect(view.getUint32(24, true)).toBe(0x9a710c2d);
    expect(view.getUint32(28, true)).toBe(0x8b3d4f5e);
    expect(view.getUint32(32, true)).toBe(0x6e2f4c1a);
    expect(view.getUint16(36, true)).toBe(1);
    expect(view.getUint16(38, true)).toBe(1);
    expect([bytes[40], bytes[41]]).toEqual([vendor.length, product.length]);
    const read = readHatEepromImage(bytes);
    expect(read.version).toBe(2);
    expect(read.atoms.map((a) => [a.type, a.index, a.crcOk])).toEqual([
      [1, 0, true],
      [3, 1, true],
    ]);
    expect(new TextDecoder().decode(read.atoms[1]!.data)).toBe('f76-sensor');
    // One flipped bit fails that atom's CRC.
    const bad = bytes.slice();
    bad[45] ^= 1;
    expect(readHatEepromImage(bad).atoms.map((a) => a.crcOk)).toEqual([false, true]);
    // A power supply atom only when the board supplies current; custom data in between.
    const more = readHatEepromImage(
      hatEepromImage({ ...spec, custom: [new Uint8Array([0xde, 0xad])], currentSupplyMa: 3000 }),
    );
    expect(more.atoms.map((a) => a.type)).toEqual([1, 3, 4, 6]);
    expect(new DataView(more.atoms[3]!.data.buffer).getUint32(0, true)).toBe(3000);
    // Refused: no UUID, too long a name, a bad overlay name, too large for a 24C32.
    const refuse = (s: Partial<typeof spec>) => {
      try {
        hatEepromImage({ ...spec, ...s });
      } catch (e) {
        return (e as PcbHatEepromError).code;
      }
    };
    expect(refuse({ productUuid: '00000000-0000-0000-0000-000000000000' })).toBe('uuid');
    expect(refuse({ vendor: 'x'.repeat(256) })).toBe('vendor');
    expect(refuse({ dtOverlay: 'a b' })).toBe('dtOverlay');
    // A quote would end eepmake's quoted string early, and `#` starts a comment there: refused
    // for the image and the settings.
    expect(refuse({ vendor: 'ACME "Labs"' })).toBe('vendor');
    expect(refuse({ product: 'a"b' })).toBe('product');
    expect(refuse({ vendor: 'ACME #1' })).toBe('vendor');
    // Empty names: eepmake would read nothing from `""`.
    expect(refuse({ vendor: '' })).toBe('vendor');
    expect(refuse({ product: '' })).toBe('product');
    expect(() => hatEepromSettings({ ...spec, vendor: 'ACME "Labs"' })).toThrow('vendor');
    expect(refuse({ custom: [new Uint8Array(5000)] })).toBe('too-large');
    // The settings file says the same for eepmake.
    expect(hatEepromSettings(spec)).toContain('product_uuid 6e2f4c1a-8b3d-4f5e-9a71-0c2d4e6f8a10');
    expect(hatEepromSettings(spec)).toContain('dt_blob "f76-sensor"');
    // Every quoted value reads back whole the way eepmake reads it (up to the next quote).
    const quoted = [...hatEepromSettings(spec).matchAll(/^(\w+) "([^"]*)"$/gm)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(quoted).toEqual([
      ['vendor', spec.vendor],
      ['product', spec.product],
      ['dt_blob', 'f76-sensor'],
    ]);
  });
});

describe('stacked boards (PB8a)', () => {
  it('TS-1955: a board names another version above it; checked like any entity', () => {
    const doc = f75Pi5Board();
    const hash = 'a'.repeat(64);
    const entry = {
      id: 'st-hat',
      name: 'Sensor HAT+',
      source: { artifactId: 'artifact-1', versionId: 'version-2', contentHash: hash },
      at: [0, 0] as [number, number],
      rotationDeg: 0,
      gapMm: 11,
    };
    const next = applyPcbOperation(doc, { type: 'insert', entities: { stack: [entry] } });
    expect(next.stack).toEqual([entry]);
    expect(codes({ ...doc, stack: [{ ...entry, gapMm: 101, rotationDeg: 360 }] })).toEqual([
      'rotation@$.stack[0].rotationDeg',
      'dimension@$.stack[0].gapMm',
    ]);
    expect(
      codes({ ...doc, stack: [{ ...entry, source: { ...entry.source, contentHash: 'x' } }] }),
    ).toEqual(['content-hash@$.stack[0].source.contentHash']);
    expect(
      codes({ ...doc, stack: Array.from({ length: 9 }, (_, i) => ({ ...entry, id: `s${i}` })) }),
    ).toEqual(['limit-count@$.stack']);
    const { stack: _, ...without } = doc;
    expect(codes(without)).toEqual(['missing-key@$.stack']);
    // DRC and fabrication files are the board's own: the same with or without the stack.
    expect(pcbDrc(next)).toEqual(pcbDrc(doc));
    expect(pcbFabricationFiles(next)).toEqual(pcbFabricationFiles(doc));
  });
});
