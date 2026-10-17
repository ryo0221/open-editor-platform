import { assertMp4Hierarchy } from './indexed-media/hierarchy.mjs';
/** Bounded independent ISO BMFF clock reader; no library-normalized packet times. */
export function mp4Index(buffer, payloadLimit) {
  if (payloadLimit) assertMp4Hierarchy(buffer, payloadLimit.sourceProfile);
  const bytes = new Uint8Array(buffer),
    v = new DataView(buffer);
  let count = 0;
  const need = (ok) => {
    if (!ok) throw Error('MP4 index profile/bounds');
  };
  function boxes(lo, hi) {
    const result = [];
    while (lo < hi) {
      need(++count < 10000 && lo + 8 <= hi);
      const size = v.getUint32(lo);
      need(size >= 8 && lo + size <= hi);
      result.push({
        p: lo,
        d: lo + 8,
        e: lo + size,
        t: String.fromCharCode(...bytes.subarray(lo + 4, lo + 8)),
      });
      lo += size;
    }
    return result;
  }
  const one = (a, t) => {
    const b = a.filter((x) => x.t === t);
    need(b.length === 1);
    return b[0];
  };
  const children = (b) => boxes(b.d, b.e);
  const u = (b, n) => {
    need(b.d + n + 4 <= b.e);
    return v.getUint32(b.d + n);
  };
  const full = (b) => need(u(b, 0) >>> 24 === 0);
  const roots = boxes(0, bytes.length);
  need(!roots.some((x) => x.t === 'moof'));
  const moov = children(one(roots, 'moov')),
    mvhd = one(moov, 'mvhd');
  need(!moov.some((x) => x.t === 'mvex'));
  full(mvhd);
  const movieScale = u(mvhd, 12),
    movieDuration = u(mvhd, 16);
  need(movieScale > 0);
  const trackBoxes = moov.filter((x) => x.t === 'trak');
  if (payloadLimit) need(trackBoxes.length >= 1 && trackBoxes.length <= 2);
  const tracks = trackBoxes.map((trak) => {
    const tr = children(trak),
      md = children(one(tr, 'mdia')),
      h = one(md, 'hdlr'),
      mh = one(md, 'mdhd'),
      tk = one(tr, 'tkhd');
    full(mh);
    full(tk);
    const kind = String.fromCharCode(...bytes.subarray(h.d + 8, h.d + 12)),
      scale = u(mh, 12);
    need(scale > 0);
    const st = children(one(children(one(md, 'minf')), 'stbl')),
      stts = one(st, 'stts');
    full(stts);
    if (payloadLimit) {
      const allowed = new Set([
        'stsd',
        'stts',
        'stss',
        'ctts',
        'stsc',
        'stsz',
        'stco',
        'co64',
        'sgpd',
        'sbgp',
        ...(payloadLimit.sourceProfile === 'iphone-sdr-v1' ? ['sdtp'] : []),
      ]);
      need(st.every((x) => allowed.has(x.t)) && new Set(st.map((x) => x.t)).size === st.length);
    }
    const n = u(stts, 4);
    need(n > 0 && n <= 10000 && stts.d + 8 + n * 8 === stts.e);
    const samples = [];
    let dts = 0;
    for (let i = 0; i < n; i++) {
      const len = u(stts, 8 + i * 8),
        duration = u(stts, 12 + i * 8);
      need(len > 0 && duration > 0 && samples.length + len <= 100000);
      for (let j = 0; j < len; j++) {
        samples.push({ dts, pts: dts, duration });
        dts += duration;
        need(Number.isSafeInteger(dts));
      }
    }
    need(dts === u(mh, 16));
    const dependency = st.find((x) => x.t === 'sdtp');
    if (dependency)
      need(u(dependency, 0) === 0 && dependency.e - dependency.d === samples.length + 4);
    const cs = st.filter((x) => x.t === 'ctts');
    need(cs.length <= 1);
    if (cs.length) {
      const c = cs[0],
        version = u(c, 0) >>> 24,
        runs = u(c, 4);
      need(version <= 1 && runs <= 10000 && c.d + 8 + runs * 8 === c.e);
      let j = 0;
      for (let i = 0; i < runs; i++) {
        const len = u(c, 8 + i * 8),
          raw = u(c, 12 + i * 8),
          offset = version === 1 ? raw | 0 : raw;
        need(len > 0 && j + len <= samples.length);
        for (let k = 0; k < len; k++) samples[j++].pts += offset;
      }
      need(j === samples.length);
    }
    if (payloadLimit) {
      const sz = one(st, 'stsz'),
        fixed = u(sz, 4),
        len = u(sz, 8);
      full(sz);
      need(len === samples.length && sz.d + 12 + (fixed ? 0 : len * 4) === sz.e);
      for (let i = 0; i < len; i++) {
        const size = fixed || u(sz, 12 + i * 4);
        need(size > 0 && size <= payloadLimit.maximumSampleBytes);
        samples[i].size = size;
      }
      const offsetBoxes = st.filter((x) => x.t === 'stco' || x.t === 'co64');
      need(offsetBoxes.length === 1);
      const co = offsetBoxes[0],
        width = co.t === 'stco' ? 4 : 8,
        chunks = u(co, 4);
      full(co);
      need(chunks > 0 && chunks <= samples.length && co.d + 8 + chunks * width === co.e);
      const sc = one(st, 'stsc'),
        runs = u(sc, 4);
      full(sc);
      need(runs > 0 && runs <= chunks && sc.d + 8 + runs * 12 === sc.e);
      const rows = [];
      for (let i = 0; i < runs; i++) {
        const first = u(sc, 8 + i * 12),
          per = u(sc, 12 + i * 12);
        need(
          first > 0 &&
            first <= chunks &&
            per > 0 &&
            per <= samples.length &&
            u(sc, 16 + i * 12) === 1,
        );
        need(i ? first > rows[i - 1].first : first === 1);
        rows.push({ first, per });
      }
      let sample = 0,
        run = 0;
      for (let chunk = 1; chunk <= chunks; chunk++) {
        if (run + 1 < runs && rows[run + 1].first === chunk) run++;
        const raw =
          width === 4
            ? BigInt(u(co, 8 + (chunk - 1) * 4))
            : v.getBigUint64(co.d + 8 + (chunk - 1) * 8);
        need(raw <= BigInt(Number.MAX_SAFE_INTEGER));
        let offset = Number(raw);
        for (let j = 0; j < rows[run].per; j++) {
          need(sample < samples.length);
          const row = samples[sample++];
          need(offset >= 0 && offset + row.size <= payloadLimit.fileBytes);
          row.offset = offset;
          offset += row.size;
        }
      }
      need(sample === samples.length);
    }
    if (payloadLimit) {
      const groups = st.filter((x) => x.t === 'sgpd' || x.t === 'sbgp');
      if (groups.length) {
        need(kind === 'soun' && groups.length === 2);
        const gd = one(st, 'sgpd'),
          gp = one(st, 'sbgp');
        need(
          gd.e - gd.d === 18 &&
            u(gd, 0) === 0x01000000 &&
            u(gd, 4) === 0x726f6c6c &&
            u(gd, 8) === 2 &&
            u(gd, 12) === 1 &&
            v.getInt16(gd.d + 16) === -1,
        );
        need(
          gp.e - gp.d === 20 &&
            u(gp, 0) === 0 &&
            u(gp, 4) === 0x726f6c6c &&
            u(gp, 8) === 1 &&
            u(gp, 12) === samples.length &&
            u(gp, 16) === 1,
        );
      }
      const sync = st.filter((x) => x.t === 'stss');
      if (sync.length) {
        const ss = sync[0],
          n = u(ss, 4);
        full(ss);
        need(n > 0 && n <= samples.length && ss.d + 8 + n * 4 === ss.e);
        let last = 0;
        for (let i = 0; i < n; i++) {
          const k = u(ss, 8 + i * 4);
          need(k > last && k <= samples.length);
          last = k;
        }
      }
    }
    let mediaStart = 0,
      presentationStart = 0,
      span = u(tk, 20);
    const ed = tr.filter((x) => x.t === 'edts');
    need(ed.length <= 1);
    if (ed.length) {
      const el = one(children(ed[0]), 'elst');
      full(el);
      const n = u(el, 4);
      need(n >= 1 && n <= 2 && el.d + 8 + n * 12 === el.e);
      for (let i = 0; i < n; i++) {
        const duration = u(el, 8 + i * 12),
          raw = u(el, 12 + i * 12);
        need(u(el, 16 + i * 12) === 65536 && duration > 0);
        if (i === 0 && n === 2) {
          need(raw === 0xffffffff);
          presentationStart = duration;
        } else {
          need(raw <= 0x7fffffff);
          mediaStart = raw;
          span = duration;
        }
      }
    }
    need(presentationStart + span === u(tk, 20));
    return { id: u(tk, 12), kind, scale, mediaStart, presentationStart, span, samples };
  });
  return { movieScale, movieDuration, tracks };
}
