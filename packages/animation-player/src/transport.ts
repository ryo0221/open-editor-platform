/** Provisional absolute-clock transport. No persisted playhead or history. */
export interface PreviewClock {
  now(): number;
  request(callback: () => void): number;
  cancel(id: number): void;
}
export function createPreviewTransport(
  duration: number,
  ticksPerSecond: number,
  clock: PreviewClock,
  render: (tick: number) => void,
  loop = false,
  range = { start: 0, end: duration },
  initialTick = 0,
) {
  if (
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    !Number.isSafeInteger(ticksPerSecond) ||
    ticksPerSecond <= 0
  )
    throw new Error('Invalid transport time');
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.start >= range.end ||
    range.end > duration
  )
    throw new Error('Invalid playback work area');
  if (!Number.isSafeInteger(initialTick) || initialTick < 0 || initialTick > duration)
    throw new Error('Invalid initial tick');
  let disposed = false,
    playing = false,
    tick = initialTick,
    anchorTick = initialTick,
    anchorTime = 0,
    rate = 1;
  let pending: number | null = null;
  let generation = 0;
  const check = () => {
    if (disposed) throw new Error('Player disposed');
  };
  const now = () => {
    const value = clock.now();
    if (!Number.isFinite(value)) throw new Error('Invalid clock');
    return value;
  };
  const sample = () => {
    const absolute =
      anchorTick + Math.floor((Math.max(0, now() - anchorTime) / 1000) * ticksPerSecond * rate);
    if (!Number.isSafeInteger(absolute)) throw new Error('Clock tick overflow');
    return loop
      ? range.start + ((absolute - range.start) % (range.end - range.start))
      : Math.min(range.end, absolute);
  };
  const cancel = () => {
    generation++;
    if (pending !== null) clock.cancel(pending);
    pending = null;
  };
  const stop = () => {
    playing = false;
    cancel();
  };
  const frame = () => {
    pending = null;
    if (disposed || !playing) return;
    try {
      tick = sample();
      render(tick);
      if (!loop && tick === range.end) stop();
      if (playing && !disposed) schedule();
    } catch (error) {
      stop();
      throw error;
    }
  };
  const schedule = () => {
    const scheduledGeneration = generation;
    pending = clock.request(() => {
      if (scheduledGeneration === generation) frame();
    });
  };
  return {
    get tick() {
      return tick;
    },
    get playing() {
      return playing;
    },
    play() {
      check();
      if (playing) return;
      if (tick < range.start || tick >= range.end) tick = range.start;
      anchorTime = now();
      anchorTick = tick;
      playing = true;
      try {
        schedule();
      } catch (error) {
        stop();
        throw error;
      }
    },
    pause() {
      check();
      if (!playing) return;
      try {
        tick = sample();
      } finally {
        stop();
      }
      render(tick);
    },
    seek(value: number) {
      check();
      if (!Number.isSafeInteger(value) || value < 0 || value > duration)
        throw new Error('Invalid seek tick');
      const time = now();
      if (playing && (value < range.start || value >= range.end)) stop();
      render(value);
      tick = value;
      anchorTick = value;
      anchorTime = time;
    },
    setRate(value: number) {
      check();
      if (!Number.isFinite(value) || value <= 0 || value > 16)
        throw new Error('Invalid playback rate');
      const resume = playing;
      this.pause();
      rate = value;
      // pause samples the current absolute clock; it may have reached the terminal pose.
      if (resume && (loop || tick < range.end)) this.play();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
    },
  };
}
