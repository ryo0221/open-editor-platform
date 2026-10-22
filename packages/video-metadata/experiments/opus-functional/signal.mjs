export function signal(n, sampleRate = 48000) {
  const data = new Float32Array(n * 2);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 2; c++) {
      const f = c ? [1511, 2671, 4001] : [997, 1597, 5003];
      const t = i / sampleRate;
      data[2 * i + c] =
        0.15 * Math.sin(2 * Math.PI * f[0] * t + 0.3 + c * 0.4) +
        0.08 * Math.sin(2 * Math.PI * f[1] * t + 0.7 + c * 0.4) +
        0.03 * Math.sin(2 * Math.PI * f[2] * t + 1.1 + c * 0.4);
    }
  return data;
}
