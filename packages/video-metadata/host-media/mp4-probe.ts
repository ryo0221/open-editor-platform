/** Bounded private feasibility profile: unfragmented SDR AVC + optional AAC, unit-rate edit. */
import type { ImportSet, ProbePort, SelectedStream } from './import';
import { IDENTITY, inspectMp4, one, type Mp4Profile, type Mp4Track } from './mp4-boxes';
const profile: Mp4Profile = {
  transforms: () => [IDENTITY],
  reference: (refs) => one(refs, 'url '),
  quickTimePadding: false,
  colorType: (r, color) => color.end === color.data + 11 && r.fourcc(color.data) === 'nclx',
  audioVersions: [0],
};
const toStream = (t: Mp4Track): SelectedStream => ({
  id: String(t.id),
  kind: t.kind,
  destination: t.kind === 'video' ? 'visual' : 'audio',
  mediaStart: t.mediaStart,
  mediaEnd: t.mediaEnd,
  presentationStart: t.presentationStart,
  ...(t.kind === 'audio' ? { sampleRate: t.scale } : {}),
});
export const mp4Probe: ProbePort = {
  async inspect(original, signal): Promise<ImportSet> {
    const streams = await inspectMp4(original, signal, profile, toStream);
    if (streams.filter((s) => s.kind === 'video').length !== 1)
      throw Error('One video track required');
    signal.throwIfAborted();
    return { streams };
  },
};
