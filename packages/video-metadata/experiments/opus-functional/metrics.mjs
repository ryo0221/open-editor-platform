export function metrics(reference, actual, c, firstTimestamp = 0, origin = 0) {
  const n = reference.length / 2,
    m = actual.length / 2,
    count = Math.min(n, m);
  let energy = 0,
    error = 0,
    cross = 0,
    out = 0,
    tail = 0,
    refTail = 0;
  for (let i = 0; i < count; i++) {
    const x = reference[2 * i + c],
      y = actual[2 * i + c];
    energy += x * x;
    error += (x - y) ** 2;
    cross += x * y;
    out += y * y;
    if (i >= n - Math.min(240, n)) {
      tail += y * y;
      refTail += x * x;
    }
  }
  let best = -Infinity,
    lag = null;
  for (let d = -96; d <= 96; d++) {
    let xy = 0,
      xx = 0,
      yy = 0,
      k = 0;
    for (let i = 0; i < Math.min(n, 4800); i++) {
      const j = i + d;
      if (j < 0 || j >= m) continue;
      const x = reference[2 * i + c],
        y = actual[2 * j + c];
      xy += x * y;
      xx += x * x;
      yy += y * y;
      k++;
    }
    const corr = k >= Math.min(n, 240) && xx && yy ? xy / Math.sqrt(xx * yy) : -Infinity;
    if (corr > best) {
      best = corr;
      lag = d;
    }
  }
  const snr = error === 0 ? Infinity : 10 * Math.log10(energy / error),
    corr = energy && out ? cross / Math.sqrt(energy * out) : null;
  const positionErrorSeconds = lag === null ? null : firstTimestamp - origin + lag / 48000;
  return {
    snr: Number.isFinite(snr) ? snr : snr === Infinity ? 'Infinity' : null,
    corr,
    lagSamples: lag,
    positionErrorSeconds,
    comparedSamples: count,
    tailEnergyRatio: refTail ? tail / refTail : null,
    pass:
      n === m &&
      snr >= 20 &&
      corr >= 0.98 &&
      lag !== null &&
      Math.abs(positionErrorSeconds) <= 0.001 &&
      tail > refTail * 0.1,
  };
}
