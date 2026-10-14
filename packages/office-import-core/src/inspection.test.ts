import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync, unzipSync, strFromU8 } from 'fflate';
import { parseOfficeXml, namespaces as ns, child, attribute } from './xml';
import { inspectOfficePackage, resolvePart } from './package';
import { importLimits } from './types';
import { readOfficeZip } from './zip';
const bytes = (s: string) => strToU8(s);
const fixture = async () => ({
  format: 'pptx' as const,
  bytes: new Uint8Array(
    await readFile(new URL('../../../tests/fixtures/office/import/external.pptx', import.meta.url)),
  ),
});
function set32(b: Uint8Array, p: number, n: number) {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(p, n, true);
}
describe('bounded Office inspection', () => {
  it('uses strict namespaces, exact attributes and UTF-16 BOM', () => {
    const source =
      '<p:x xmlns:p="urn:p" xmlns:r="urn:r"><p:y r:id="a">日本語 &amp; text</p:y></p:x>';
    const n = parseOfficeXml(bytes(source), 'test.xml');
    expect(child(n, 'y', 'urn:p')?.text).toBe('日本語 & text');
    expect(attribute(child(n, 'y', 'urn:p'), 'id', 'urn:r')).toBe('a');
    expect(child(n, 'y', 'urn:wrong')).toBeUndefined();
    const mixed = parseOfficeXml(
      bytes('<x xmlns:p="urn:p" xmlns:q="urn:q"><p:y/><q:y/></x>'),
      'mixed.xml',
    );
    expect(mixed.children.map((n) => n.path)).toEqual(['/x[1]/y[1]', '/x[1]/y[2]']);
    const raw = new Uint8Array(2 + source.length * 2);
    raw.set([255, 254]);
    const v = new DataView(raw.buffer);
    for (let i = 0; i < source.length; i++) v.setUint16(2 + i * 2, source.charCodeAt(i), true);
    expect(parseOfficeXml(raw, 'test.xml')).toEqual(n);
  });
  it.each([
    '<!DOCTYPE x [<!ENTITY secret SYSTEM "https://example.com/secret">]><x>&secret;</x>',
    '<x>&unknown;</x>',
    '<r:x/>',
    '<x a="1" a="2"/>',
    '<x><y></x>',
    '<?xml-stylesheet href="https://example.com/x"?><x/>',
  ])('rejects malformed or active XML without a resolver: %s', (source) => {
    expect(() => parseOfficeXml(bytes(source), 'bad.xml')).toThrow();
  });
  it('enforces XML size/depth/attribute bounds including exact depth', () => {
    expect(() =>
      parseOfficeXml(bytes('<x>'.repeat(64) + '</x>'.repeat(64)), 'depth.xml'),
    ).not.toThrow();
    expect(() => parseOfficeXml(bytes('<x>'.repeat(65) + '</x>'.repeat(65)), 'depth.xml')).toThrow(
      /depth.xml/,
    );
    expect(() => parseOfficeXml(new Uint8Array(importLimits.xmlBytes + 1), 'large.xml')).toThrow();
    expect(() =>
      parseOfficeXml(
        bytes(`<x ${Array.from({ length: 257 }, (_, i) => `a${i}="v"`).join(' ')}/>`),
        'attrs.xml',
      ),
    ).toThrow();
  });
  it('rejects traversal, local/central inconsistencies, duplicate parts and CRC corruption', async () => {
    await expect(readOfficeZip(zipSync({ '../a.xml': bytes('<a/>') }))).rejects.toMatchObject({
      code: 'INVALID_ZIP',
    });
    const zip = zipSync({ 'a.xml': bytes('<a/>') }, { level: 0 });
    const altered = zip.slice();
    altered[30 + 5] ^= 1;
    await expect(readOfficeZip(altered)).rejects.toThrow(/CRC/);
    const mismatch = zip.slice();
    set32(mismatch, 22, 99);
    await expect(readOfficeZip(mismatch)).rejects.toThrow(/mismatch/);
    const two = zipSync({ 'a.xml': bytes('<a/>'), 'b.xml': bytes('<b/>') });
    for (let i = 0; i < two.length - 5; i++)
      if (String.fromCharCode(...two.subarray(i, i + 5)) === 'b.xml') two[i] = 97;
    await expect(readOfficeZip(two)).rejects.toThrow(/Duplicate/);
  });
  it('observes actual inflate size even when both headers underdeclare a bomb', async () => {
    const zip = zipSync({ 'bomb.bin': new Uint8Array(1024 * 1024) });
    set32(zip, 22, 1);
    const central = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    set32(zip, central + 24, 1);
    await expect(readOfficeZip(zip)).rejects.toThrow(/Actual expansion/);
  });
  it('checks compressed/entry/expanded declared limits and cancellation', async () => {
    await expect(
      readOfficeZip(new Uint8Array(importLimits.compressedBytes + 1)),
    ).rejects.toMatchObject({ code: 'COMPRESSED_LIMIT' });
    const entries = Object.fromEntries(
      Array.from({ length: importLimits.entries + 1 }, (_, i) => [`${i}.bin`, new Uint8Array()]),
    );
    await expect(readOfficeZip(zipSync(entries, { level: 0 }))).rejects.toMatchObject({
      code: 'ENTRY_LIMIT',
    });
    const zip = zipSync({ 'x.bin': new Uint8Array(1) });
    set32(zip, 22, importLimits.expandedBytes + 1);
    const c = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    set32(zip, c + 24, importLimits.expandedBytes + 1);
    await expect(readOfficeZip(zip)).rejects.toMatchObject({ code: 'EXPANDED_LIMIT' });
    const controller = new AbortController();
    controller.abort();
    await expect(readOfficeZip(zip, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });
  it('inspects a real independent OPC package and resolves canonical part references', async () => {
    const p = await inspectOfficePackage(await fixture());
    expect(p.mainPart).toBe('ppt/presentation.xml');
    expect(p.related('ppt/slides/slide1.xml', 'slideLayout')).toBe(
      'ppt/slideLayouts/slideLayout1.xml',
    );
    expect(p.xml(p.mainPart).uri).toBe(ns.p);
    expect(resolvePart('ppt/slides/slide1.xml', '../media/image1.png')).toBe(
      'ppt/media/image1.png',
    );
    expect(() => resolvePart('ppt/a.xml', '../../escape')).toThrow();
    expect(() => resolvePart('ppt/a.xml', '%2e%2e/escape')).toThrow();
  });
  it('rejects missing references, DTD in unused parts, macro and Strict profiles', async () => {
    const s = await fixture();
    const mutate = async (part: string, from: string, to: string) => {
      const files = unzipSync(s.bytes);
      files[part] = bytes(strFromU8(files[part]).replace(from, to));
      return inspectOfficePackage({ ...s, bytes: zipSync(files) });
    };
    await expect(
      mutate(
        'ppt/slides/_rels/slide1.xml.rels',
        '../slideLayouts/slideLayout1.xml',
        '../slideLayouts/missing.xml',
      ),
    ).rejects.toMatchObject({ code: 'MISSING_PART' });
    await expect(
      mutate(
        '[Content_Types].xml',
        'presentationml.presentation.main+xml',
        'presentationml.presentation.macroEnabled.main+xml',
      ),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    await expect(
      mutate('ppt/presentation.xml', ns.p, 'http://purl.oclc.org/ooxml/presentationml/main'),
    ).rejects.toMatchObject({ code: 'STRICT_PROFILE_UNSUPPORTED' });
    const files = unzipSync(s.bytes);
    files['docProps/core.xml'] = bytes('<!DOCTYPE x><x/>');
    await expect(inspectOfficePackage({ ...s, bytes: zipSync(files) })).rejects.toMatchObject({
      code: 'DTD_BLOCKED',
    });
  });
});
// Real maximum-size expansion and cancellation need a bounded conformance budget.
// Keep every byte limit and cancellation assertion unchanged.
it('accepts the exact XML/entry/expanded byte caps and cancels actual expansion', async () => {
  const max = importLimits.xmlBytes;
  const xml = new Uint8Array(max).fill(32);
  xml.set(strToU8('<x>'));
  xml.set(strToU8('</x>'), max - 4);
  expect(parseOfficeXml(xml, 'exact.xml').text.length).toBe(max - 7);
  const entries = Object.fromEntries(
    Array.from({ length: importLimits.entries }, (_, i) => [`${i}.bin`, new Uint8Array()]),
  );
  expect((await readOfficeZip(zipSync(entries, { level: 0 }))).size).toBe(importLimits.entries);
  const expanded = zipSync({ 'limit.bin': new Uint8Array(importLimits.expandedBytes) });
  expect((await readOfficeZip(expanded)).get('limit.bin')?.length).toBe(importLimits.expandedBytes);
  const controller = new AbortController();
  const pending = readOfficeZip(expanded, controller.signal);
  setTimeout(() => controller.abort(), 0);
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
}, 120000);
it('accepts exactly 32 MiB compressed bytes with stored data', async () => {
  const overhead = zipSync({ 'x.bin': new Uint8Array() }, { level: 0 }).length;
  const zip = zipSync(
    { 'x.bin': new Uint8Array(importLimits.compressedBytes - overhead) },
    { level: 0 },
  );
  expect(zip.length).toBe(importLimits.compressedBytes);
  expect((await readOfficeZip(zip)).get('x.bin')?.length).toBe(
    importLimits.compressedBytes - overhead,
  );
}, 120000);
