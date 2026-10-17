/** Narrow, bounded grammar before an external demuxer sees metadata.
 * Pinned parser recurses by box name, not by canonical path. Validate every
 * reachable container (including sample entries and metadata) before admission.
 */
const rules = {
  root: ['ftyp', 'wide', 'free', 'mdat', 'moov'],
  moov: ['mvhd', 'trak', 'udta', 'meta'],
  trak: ['tkhd', 'edts', 'mdia', 'udta', 'tapt'],
  edts: ['elst'],
  mdia: ['mdhd', 'hdlr', 'minf'],
  minf: ['vmhd', 'smhd', 'hdlr', 'dinf', 'stbl'],
  dinf: ['dref'],
  stbl: ['stsd', 'stts', 'ctts', 'stss', 'stsc', 'stsz', 'stco', 'co64', 'sgpd', 'sbgp'],
  stsd: ['avc1', 'mp4a'],
  avc1: ['avcC', 'colr', 'pasp', 'btrt', 'clap'],
  mp4a: ['esds', 'wave', 'chan', 'btrt'],
  wave: ['frma', 'mp4a', 'esds', '\0\0\0\0'],
  udta: ['meta', '©swr', '©day', '©xyz', '©mod', '©mak', '©too', '©nam'],
  meta: ['hdlr', 'keys', 'ilst'],
};
const required = {
  root: ['moov'],
  moov: ['mvhd', 'trak'],
  trak: ['tkhd', 'mdia'],
  mdia: ['mdhd', 'hdlr', 'minf'],
  minf: ['dinf', 'stbl'],
  dinf: ['dref'],
  stbl: ['stsd', 'stts', 'stsc', 'stsz'],
  edts: ['elst'],
  avc1: ['avcC'],
};
function need(ok) {
  if (!ok) throw Error('MP4 hierarchy/profile');
}
/** Pure structural check; tests never send noncanonical structures to a codec. */
export function assertChildKinds(parent, kinds, sourceProfile) {
  const allowed =
    parent === 'stbl' && sourceProfile === 'iphone-sdr-v1'
      ? [...rules.stbl, 'sdtp']
      : rules[parent];
  need(allowed && kinds.every((k) => allowed.includes(k)));
  for (const kind of kinds) {
    const repeat =
      (parent === 'root' && ['mdat', 'free', 'wide'].includes(kind)) ||
      (parent === 'moov' && kind === 'trak');
    need(repeat || kinds.filter((k) => k === kind).length === 1);
  }
  need((required[parent] ?? []).every((k) => kinds.includes(k)));
  if (parent === 'stbl') need(kinds.includes('stco') !== kinds.includes('co64'));
  if (parent === 'minf') need(kinds.includes('vmhd') !== kinds.includes('smhd'));
  if (parent === 'stsd') need(kinds.length === 1);
  if (parent === 'mp4a') need(kinds.includes('esds') !== kinds.includes('wave'));
}
export function assertMp4Hierarchy(buffer, sourceProfile) {
  const bytes = new Uint8Array(buffer),
    view = new DataView(buffer);
  need(bytes.length <= 8 * 1024 * 1024);
  let count = 0;
  const word = (p, end) => {
    need(p + 4 <= end);
    return view.getUint32(p);
  };
  const type = (p) => String.fromCharCode(...bytes.subarray(p, p + 4));
  function boxes(lo, hi, padding = false) {
    const result = [];
    while (lo < hi) {
      if (padding && hi - lo === 4 && word(lo, hi) === 0) break;
      need(++count <= 10000 && lo + 8 <= hi);
      const size = word(lo, hi);
      need(size >= 8 && lo + size <= hi);
      result.push({ type: type(lo + 4), start: lo + 8, end: lo + size });
      lo += size;
    }
    return result;
  }
  function visit(parent, lo, hi, depth = 0, mediaKind) {
    need(depth <= 10);
    const children = boxes(lo, hi, parent === 'avc1' && sourceProfile === 'iphone-sdr-v1');
    assertChildKinds(
      parent,
      children.map((b) => b.type),
      sourceProfile,
    );
    if (parent === 'mdia') {
      const handler = children.find((b) => b.type === 'hdlr');
      need(handler.start + 12 <= handler.end);
      mediaKind = type(handler.start + 8);
      need(children.indexOf(handler) < children.findIndex((b) => b.type === 'minf'));
    }
    if (parent === 'stsd')
      need(
        children[0].type === (mediaKind === 'vide' ? 'avc1' : mediaKind === 'soun' ? 'mp4a' : ''),
      );
    if (parent === 'minf')
      need(children.some((b) => b.type === (mediaKind === 'vide' ? 'vmhd' : 'smhd')));
    for (const b of children) {
      let start = b.start;
      if (parent === 'wave') {
        // The mp4a marker inside wave is not a sample entry.
        if (b.type === 'mp4a')
          need(
            b.end === start ||
              (sourceProfile === 'iphone-sdr-v1' &&
                b.end === start + 4 &&
                word(start, b.end) === 0),
          );
        if (b.type === '\0\0\0\0') need(b.end === start);
        if (b.type === 'frma') need(b.end === start + 4 && type(start) === 'mp4a');
        continue;
      }
      if (b.type === 'stsd') {
        need(word(start, b.end) === 0 && word(start + 4, b.end) === 1);
        start += 8;
      }
      if (b.type === 'avc1') {
        need(start + 78 <= b.end && view.getUint16(start + 6) === 1);
        start += 78;
      }
      if (b.type === 'mp4a') {
        need(start + 28 <= b.end && view.getUint16(start + 6) === 1);
        const version = view.getUint16(start + 8);
        need(version === 0 || version === 1);
        start += version === 1 ? 44 : 28;
        need(start <= b.end);
      }
      if (b.type === 'meta') {
        if (word(start, b.end) === 0) start += 4;
      }
      if (b.type === 'hdlr') {
        need(start + 12 <= b.end);
        const handler = type(start + 8);
        if (parent === 'mdia') need(handler === 'vide' || handler === 'soun');
        // QuickTime data handler cannot replace the track's media declaration.
        if (parent === 'minf') need(handler === 'alis');
        if (parent === 'meta') need(handler === 'mdir' || handler === 'mdta');
      }
      if (b.type === 'dref') {
        need(word(start, b.end) === 0 && word(start + 4, b.end) === 1);
        const refs = boxes(start + 8, b.end);
        need(
          refs.length === 1 &&
            (refs[0].type === 'url ' ||
              (sourceProfile === 'iphone-sdr-v1' && refs[0].type === 'alis')) &&
            refs[0].end === refs[0].start + 4 &&
            word(refs[0].start, refs[0].end) === 1,
        );
      }
      if (rules[b.type]) visit(b.type, start, b.end, depth + 1, mediaKind);
    }
    return children;
  }
  visit('root', 0, bytes.length);
}
