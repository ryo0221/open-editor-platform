export function metrics(
  reference: Float32Array,
  actual: Float32Array,
  channel: number,
  firstTimestamp?: number,
  origin?: number,
): {
  snr: number | string | null;
  corr: number | null;
  lagSamples: number | null;
  positionErrorSeconds: number | null;
  comparedSamples: number;
  tailEnergyRatio: number | null;
  pass: boolean;
};
