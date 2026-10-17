// Read-only real-original feasibility. Not an import adapter or an adopted interpretation.
import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { metadataBlob } from '../indexed-media/metadata.ts';
import { mp4Index } from '../mp4-index.mjs';
import { mp4Probe } from '../mp4-probe';
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
globalThis.inspectFileSource = async () => {
  const original = globalThis.document.querySelector('#source').files[0],
    signal = new globalThis.AbortController().signal;
  original.arrayBuffer = () => {
    throw Error('Whole original buffer prohibited');
  };
  const metadata = await metadataBlob(original, signal),
    buffer = await metadata.arrayBuffer(),
    index = mp4Index(buffer, { maximumSampleBytes: 1024 * 1024, fileBytes: original.size });
  let existingProbe;
  try {
    await mp4Probe.inspect(metadata, signal);
    existingProbe = 'unexpected-pass';
  } catch (e) {
    existingProbe = String(e);
  }
  const audio = index.tracks.find((t) => t.kind === 'soun'),
    video = index.tracks.find((t) => t.kind === 'vide');
  const sampleNumerator = BigInt(audio.span) * BigInt(audio.scale),
    denominator = BigInt(index.movieScale);
  const source = new Input({
    source: new BlobSource(original, { maxCacheSize: 1024 * 1024, useStreamReader: false }),
    formats: ALL_FORMATS,
  });
  let decoder, frame;
  try {
    const vt = await source.getPrimaryVideoTrack(),
      at = await source.getPrimaryAudioTrack(),
      vc = await vt.getDecoderConfig(),
      ac = await at.getDecoderConfig();
    const rotation = await vt.getRotation(),
      display = [await vt.getDisplayWidth(), await vt.getDisplayHeight()];
    need((await globalThis.VideoDecoder.isConfigSupported(vc)).supported, 'Native AVC config');
    need((await globalThis.AudioDecoder.isConfigSupported(ac)).supported, 'Native AAC config');
    const packet = await new EncodedPacketSink(vt).getFirstPacket({ verifyKeyPackets: true });
    need(
      packet.sequenceNumber === 0 && packet.type === 'key',
      'First independently verified key packet',
    );
    let failure;
    decoder = new globalThis.VideoDecoder({
      error: (e) => {
        failure = e;
      },
      output: (f) => {
        need(!frame, 'Unexpected extra frame');
        frame = f;
      },
    });
    decoder.configure(vc);
    decoder.decode(
      new globalThis.EncodedVideoChunk({ type: 'key', timestamp: 0, data: packet.data }),
    );
    await decoder.flush();
    if (failure) throw failure;
    need(frame, 'Missing native frame');
    const canvas = globalThis.document.querySelector('#frame');
    canvas.width = 270;
    canvas.height = 480;
    need(
      rotation === 90 && display[0] === 1080 && display[1] === 1920,
      'Fixture display interpretation',
    );
    const ctx = canvas.getContext('2d');
    ctx.translate(270, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(frame, 0, 0, 480, 270);
    const pixels = Array.from(ctx.getImageData(0, 0, 270, 480).data);
    frame.close();
    frame = undefined;
    decoder.close();
    decoder = undefined;
    const sink = new EncodedPacketSink(at),
      blocks = [];
    let samples = 0;
    const ad = new globalThis.AudioDecoder({
      error: (e) => {
        failure = e;
      },
      output: (a) => {
        try {
          need(a.sampleRate === 44100 && a.numberOfChannels === 1, 'Actual mono AAC shape');
          samples += a.numberOfFrames;
          blocks.push({ timestamp: a.timestamp, frames: a.numberOfFrames });
        } finally {
          a.close();
        }
      },
    });
    try {
      ad.configure(ac);
      let p = await sink.getFirstPacket();
      for (let i = 0; i < 8; i++) {
        need(p && p.sequenceNumber === i, 'AAC sample index');
        const row = audio.samples[i];
        ad.decode(
          new globalThis.EncodedAudioChunk({
            type: p.type,
            timestamp: Math.floor((row.pts * 1e6) / audio.scale),
            data: p.data,
          }),
        );
        p = await sink.getNextPacket(p);
      }
      await ad.flush();
      if (failure) throw failure;
    } finally {
      ad.close();
    }
    return {
      originalBytes: original.size,
      metadataBytes: metadata.size,
      existingProbe,
      video: {
        rawScale: video.scale,
        samples: video.samples.length,
        rotationClockwise: rotation,
        display,
        rawWidth: vc.codedWidth,
        rawHeight: vc.codedHeight,
        duration: index.movieDuration,
        movieScale: index.movieScale,
      },
      audio: {
        config: {
          codec: ac.codec,
          sampleRate: ac.sampleRate,
          numberOfChannels: ac.numberOfChannels,
        },
        codedSamples: audio.samples.reduce((n, s) => n + s.duration, 0),
        exactEditSamples: {
          numerator: sampleNumerator.toString(),
          denominator: denominator.toString(),
          remainder: (sampleNumerator % denominator).toString(),
        },
        decodedPrefixSamples: samples,
        blocks,
      },
      pixels,
    };
  } finally {
    frame?.close();
    if (decoder && decoder.state !== 'closed') decoder.close();
    source.dispose();
  }
};
