// Private narrow-profile extraction of the reviewed AAC timing correction; no media payload changes.
export function correctMetadata(buffer, { rate, count, origin, rawPackets }) {
  const view = new DataView(buffer),
    bytes = new Uint8Array(buffer),
    boxes = [];
  function walk(start, end, track = null) {
    for (let p = start; p < end; ) {
      const n = view.getUint32(p),
        type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
      if (n < 8 || p + n > end) throw Error('invalid generated box');
      const owner = type === 'trak' ? p : track;
      boxes.push({ p, type, n, track: owner });
      if (['moov', 'trak', 'mdia', 'edts'].includes(type)) walk(p + 8, p + n, owner);
      p += n;
    }
  }
  walk(0, buffer.byteLength);
  function one(type, track = null) {
    const found = boxes.filter((b) => b.type === type && b.track === track);
    if (found.length !== 1 || view.getUint8(found[0].p + 8) !== 0)
      throw Error('unsupported generated ' + type);
    return found[0].p;
  }
  const mdat = boxes.find((b) => b.type === 'mdat');
  if (!mdat) throw Error('missing generated media');
  const originalMedia = bytes.slice(mdat.p, mdat.p + mdat.n);
  const tracks = boxes.filter((b) => b.type === 'trak'),
    audioTrack = tracks.find((t) => {
      const h = one('hdlr', t.p);
      return String.fromCharCode(...bytes.subarray(h + 16, h + 20)) === 'soun';
    });
  if (!audioTrack || tracks.length !== (count > 1024 ? 2 : 1))
    throw Error('unexpected generated tracks');
  const mvhd = one('mvhd'),
    oldMovieRate = view.getUint32(mvhd + 20),
    originSamples = Math.round(origin * rate),
    delay = originSamples - rawPackets[0].pts;
  if (delay !== 1024 || view.getUint32(one('mdhd', audioTrack.p) + 20) !== rate)
    throw Error('unexpected encoder timing');
  // Keep coded access units, track timebases and stts intact. Change movie timebase
  // to sample units; rescale every movie-unit duration including the video edits.
  view.setUint32(mvhd + 20, rate);
  view.setUint32(mvhd + 24, originSamples + count);
  for (const t of tracks) {
    const tkhd = one('tkhd', t.p),
      hasEdits = boxes.some((b) => b.type === 'elst' && b.track === t.p),
      elst = hasEdits ? one('elst', t.p) : null,
      entries = hasEdits ? view.getUint32(elst + 12) : 0;
    if (!hasEdits && (t.p === audioTrack.p || origin !== 0)) throw Error('missing expected edit');
    view.setUint32(tkhd + 28, Math.round((view.getUint32(tkhd + 28) * rate) / oldMovieRate));
    for (let i = 0; i < entries; i++) {
      const at = elst + 16 + i * 12;
      view.setUint32(at, Math.round((view.getUint32(at) * rate) / oldMovieRate));
    }
    if (t.p === audioTrack.p) {
      if (entries !== (origin > 0 ? 2 : 1)) throw Error('unexpected audio edit layout');
      view.setUint32(tkhd + 28, originSamples + count);
      let entry = elst + 16;
      if (entries === 2) {
        view.setUint32(entry, originSamples);
        view.setInt32(entry + 4, -1);
        entry += 12;
      }
      view.setUint32(entry, count);
      view.setInt32(entry + 4, delay);
    }
  }
  // Assert metadata independently of consumer behavior. Never slice decoded PCM.
  const elst = one('elst', audioTrack.p),
    n = view.getUint32(elst + 12),
    last = elst + 16 + (n - 1) * 12;
  if (view.getUint32(last) !== count || view.getInt32(last + 4) !== delay)
    throw Error('edit readback mismatch');
  if (!originalMedia.every((v, i) => v === bytes[mdat.p + i])) throw Error('coded media changed');
  const evidence = {
    compositionOriginSamples: originSamples,
    validInputSamples: count,
    rawFirstPts: rawPackets[0].pts,
    measuredHeadDelay: delay,
    tailPadding: rawPackets.reduce((n, p) => n + p.duration, 0) - delay - count,
    movieTimescale: rate,
    editMediaTime: view.getInt32(last + 4),
    editDuration: view.getUint32(last),
    codedMediaUnchanged: true,
  };
  return { buffer, evidence };
}
