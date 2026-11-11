import { describe, expect, it } from 'vitest';
import { base64, boxTetMesh, readVtu, unbase64, VtuError, writeVtu } from './index';

function decodeBlock(b64: string) {
  const raw = Uint8Array.from(Buffer.from(b64, 'base64'));
  const length = new DataView(raw.buffer).getUint32(0, true);
  return { length, data: raw.subarray(4) };
}

describe('VTU', () => {
  it('encodes base64 like the platform does', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect(base64(b)).toBe(Buffer.from(b).toString('base64'));
    }
  });

  it('writes points, tet10 cells and fields that read back', () => {
    const mesh = boxTetMesh({ size: [2, 1, 1], divisions: [2, 1, 1], type: 'tet10' });
    const n = mesh.nodes.length / 3;
    const m = mesh.elements.length / 10;
    const disp = new Float64Array(n * 3).map((_, i) => i * 0.5);
    const xml = writeVtu({
      mesh,
      pointData: [{ name: 'Displacement', components: 3, values: disp }],
      cellData: [{ name: 'von Mises', components: 1, values: new Float64Array(m).fill(2) }],
    });
    expect(xml).toContain(`<Piece NumberOfPoints="${n}" NumberOfCells="${m}">`);
    const arrays = [...xml.matchAll(/<DataArray ([^>]*)>([^<]*)<\/DataArray>/g)];
    const byName = new Map(arrays.map((a) => [/Name="([^"]*)"/.exec(a[1]!)?.[1] ?? 'Points', a]));
    const points = decodeBlock(byName.get('Points')![2]!);
    expect(points.length).toBe(n * 24);
    expect(new Float64Array(points.data.slice().buffer)).toEqual(mesh.nodes);
    const types = decodeBlock(byName.get('types')![2]!);
    expect([...types.data]).toEqual(new Array(m).fill(24));
    const d = decodeBlock(byName.get('Displacement')![2]!);
    expect(new Float64Array(d.data.slice().buffer)).toEqual(disp);
    expect(byName.get('von Mises')![1]).toContain('NumberOfComponents="1"');
  });

  it('writes shell triangles as VTK triangles with a cell field (R3i-4)', () => {
    const mesh = {
      type: 'tri3' as const,
      nodes: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      elements: Uint32Array.from([0, 1, 2, 1, 3, 2]),
    };
    const text = writeVtu({
      mesh,
      cellData: [{ name: 'Thickness (mm)', components: 1, values: Float64Array.from([2, 2]) }],
    });
    expect(text).toContain('NumberOfPoints="4" NumberOfCells="2"');
    expect(text).toContain('Name="Thickness (mm)"');
    // Offsets 3, 6 and type 5 (VTK_TRIANGLE) for both cells.
    const types = /Name="types" format="binary">([^<]+)</.exec(text)![1]!;
    expect([...unbase64(types).subarray(4)]).toEqual([5, 5]);
    const offsets = /Name="offsets" format="binary">([^<]+)</.exec(text)![1]!;
    const o = unbase64(offsets);
    const view = new DataView(o.buffer, o.byteOffset + 4);
    expect([view.getInt32(0, true), view.getInt32(4, true)]).toEqual([3, 6]);
    // R3i-5: and reads them back as triangles.
    const back = readVtu(text);
    expect(back.type).toBe('tri3');
    expect([...back.elements]).toEqual([0, 1, 2, 1, 3, 2]);
    expect([...back.cellData[0]!.values]).toEqual([2, 2]);
  });

  it('refuses fields that do not fit', () => {
    const mesh = boxTetMesh({ size: [1, 1, 1], divisions: [1, 1, 1], type: 'tet4' });
    const bad = (name: string, values: Float64Array) => () =>
      writeVtu({ mesh, pointData: [{ name, components: 1, values }] });
    expect(bad('a', new Float64Array(3))).toThrow(/vtu-field-length/);
    expect(bad('a', new Float64Array(8).fill(Number.NaN))).toThrow(/vtu-field-value/);
    expect(bad('<x>', new Float64Array(8))).toThrow(/vtu-field-name/);
  });

  it('reads back what it writes (tet4 and tet10, point and cell fields)', () => {
    for (const type of ['tet4', 'tet10'] as const) {
      const mesh = boxTetMesh({ size: [2, 1, 1], divisions: [2, 1, 1], type });
      const n = mesh.nodes.length / 3;
      const m = mesh.elements.length / (type === 'tet4' ? 4 : 10);
      const disp = new Float64Array(n * 3).map((_, i) => Math.sin(i) * 1e-3);
      const stress = new Float64Array(m * 6).map((_, i) => i - 7.25);
      const xml = writeVtu({
        mesh,
        pointData: [{ name: 'Displacement', components: 3, values: disp }],
        cellData: [{ name: 'Stress (MPa)', components: 6, values: stress }],
      });
      const back = readVtu(xml);
      expect(back.type).toBe(type);
      expect(back.nodes).toEqual(mesh.nodes);
      expect(back.elements).toEqual(mesh.elements);
      expect(back.pointData).toEqual([{ name: 'Displacement', components: 3, values: disp }]);
      expect(back.cellData).toEqual([{ name: 'Stress (MPa)', components: 6, values: stress }]);
    }
  });

  it('decodes strict base64 only', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 53 + 3) & 255);
      expect(unbase64(base64(b))).toEqual(b);
    }
    for (const bad of ['QQ', 'QQ=a', 'Q===', 'QU*=', 'Q=QQ'])
      expect(() => unbase64(bad)).toThrow(VtuError);
  });

  it('refuses what it does not read, and anything that does not fit', () => {
    const mesh = boxTetMesh({ size: [1, 1, 1], divisions: [1, 1, 1], type: 'tet4' });
    const n = mesh.nodes.length / 3;
    const good = writeVtu({
      mesh,
      pointData: [{ name: 'T', components: 1, values: new Float64Array(n) }],
    });
    expect(readVtu(good).nodes.length).toBe(n * 3);
    const problem = (text: string, limits?: Parameters<typeof readVtu>[1]) => {
      try {
        readVtu(text, limits);
      } catch (e) {
        expect(e).toBeInstanceOf(VtuError);
        expect((e as VtuError).code).toBe('result-invalid');
        return (e as VtuError).problem;
      }
      return 'read';
    };
    const swap = (a: string | RegExp, b: string) => good.replace(a, b);
    const block = (bytes: number[], header = bytes.length) => {
      const out = new Uint8Array(4 + bytes.length);
      new DataView(out.buffer).setUint32(0, header, true);
      out.set(bytes, 4);
      return base64(out);
    };
    const f64 = (values: number[]) => {
      const b = new Uint8Array(values.length * 8);
      values.forEach((v, i) => new DataView(b.buffer).setFloat64(i * 8, v, true));
      return [...b];
    };
    const arrayOf = (name: string) =>
      new RegExp(`(<DataArray[^>]*Name="${name}"[^>]*>)[^<]*(</DataArray>)`);
    expect(problem('not xml')).toBe('syntax');
    expect(problem(good.replace('</Piece>', ''))).toBe('syntax');
    expect(problem(swap('<!-- -->', '') + '<!-- x -->')).toBe('syntax');
    expect(problem(swap('LittleEndian', 'BigEndian'))).toBe('format');
    expect(problem(swap('header_type="UInt32"', 'header_type="UInt64"'))).toBe('format');
    expect(problem(swap('<VTKFile ', '<VTKFile compressor="vtkZLibDataCompressor" '))).toBe(
      'format',
    );
    expect(problem(swap(/format="binary"/, 'format="ascii"'))).toBe('format');
    expect(problem(swap('type="UnstructuredGrid" version', 'type="PolyData" version'))).toBe(
      'format',
    );
    expect(
      problem(swap('</Piece>', '</Piece><Piece NumberOfPoints="0" NumberOfCells="0"></Piece>')),
    ).toBe('structure');
    expect(problem(swap('<Points>', '<Verts></Verts><Points>'))).toBe('structure');
    expect(problem(swap(`NumberOfPoints="${n}"`, `NumberOfPoints="${n + 1}"`))).toBe('length');
    expect(problem(good, { bytes: 100, nodes: 1e6, elements: 1e6, fields: 32 })).toBe('too-large');
    expect(problem(good, { bytes: 1e9, nodes: n - 1, elements: 1e6, fields: 32 })).toBe(
      'too-large',
    );
    // A block whose header disagrees with its bytes.
    expect(problem(swap(arrayOf('T'), `$1${block(f64(new Array(n).fill(0)), 8)}$2`))).toBe(
      'length',
    );
    expect(
      problem(swap(arrayOf('T'), `$1${block(f64([Number.NaN, ...new Array(n - 1).fill(0)]))}$2`)),
    ).toBe('not-finite');
    expect(problem(swap(/(Name="T") NumberOfComponents="1"/, '$1 NumberOfComponents="2"'))).toBe(
      'field',
    );
    expect(problem(swap(/type="Float64" Name="T"/, 'type="Float32" Name="T"'))).toBe('array');
    // Cells: another type, an index out of range, a bad offset.
    const m = mesh.elements.length / 4;
    expect(problem(swap(arrayOf('types'), `$1${block(new Array(m).fill(12))}$2`))).toBe('cell');
    expect(
      problem(swap(arrayOf('types'), `$1${block([10, ...new Array(m - 1).fill(24)])}$2`)),
    ).toBe('cell');
    const i32 = (values: number[]) => {
      const b = new Uint8Array(values.length * 4);
      values.forEach((v, i) => new DataView(b.buffer).setInt32(i * 4, v, true));
      return [...b];
    };
    expect(
      problem(
        swap(arrayOf('connectivity'), `$1${block(i32([n, ...[...mesh.elements].slice(1)]))}$2`),
      ),
    ).toBe('index');
    expect(
      problem(
        swap(
          arrayOf('offsets'),
          `$1${block(i32([...new Array(m)].map((_, e) => (e + 1) * 4 + (e === 0 ? 1 : 0))))}$2`,
        ),
      ),
    ).toBe('cell');
  });
});
