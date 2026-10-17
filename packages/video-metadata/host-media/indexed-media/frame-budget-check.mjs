// Deterministic resource/ownership faults against the real reader; no codec or performance claim.
import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import console from 'node:console';
const fixture = `
export const ALL_FORMATS = [];
export class BlobSource {}
export class BufferSource {}
export class Input {
  async getPrimaryVideoTrack() { return {
    getDecoderConfig: async () => ({codec:'avc1.640028',codedWidth:1920,codedHeight:1080,description:new Uint8Array([1,0,0,0,3,0,0])}),
    getRotation: async () => 90
  }; }
  dispose() {}
}
const packet = n => ({sequenceNumber:n,type:n%64===0?'key':'delta',data:new Uint8Array([0,0,0,1,0x65])});
export class EncodedPacketSink {
  async getKeyPacket(p) { return packet(Math.floor(p*25/64)*64); }
  async getNextKeyPacket(p) { return p.sequenceNumber===0 ? packet(64) : null; }
  async getNextPacket(p) { return packet(p.sequenceNumber+1); }
}
export function mp4Index() { return {movieScale:25,tracks:[{kind:'vide',scale:25,mediaStart:0,presentationStart:0,samples:Array.from({length:128},(_,i)=>({pts:i,duration:1}))}]}; }
export async function metadataBlob() { return new globalThis.Blob([]); }
export const mp4Probe = {inspect:async()=>{}};
export const mp4ProbeV1 = mp4Probe;
`;
const built = await build({
  entryPoints: ['packages/video-metadata/host-media/indexed-media/video-window.mjs'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'reader-io-faults',
      setup(b) {
        b.onResolve(
          { filter: /^(mediabunny|.*(?:mp4-index\.mjs|mp4-probe|probe-v1\.ts|metadata\.ts))$/ },
          () => ({ path: 'fixture', namespace: 'fault' }),
        );
        b.onLoad({ filter: /.*/, namespace: 'fault' }, () => ({ contents: fixture, loader: 'js' }));
      },
    },
  ],
});
let mode,
  constructed = 0,
  cloned = 0,
  open = 0,
  decoding,
  lastOutput;
const originalDecoder = globalThis.VideoDecoder,
  originalChunk = globalThis.EncodedVideoChunk;
class Frame {
  constructor(timestamp) {
    this.timestamp = timestamp;
    this.codedWidth = 1920;
    this.codedHeight = 1090;
    this.displayWidth = 1920;
    this.displayHeight = 1080;
    open++;
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      open--;
    }
  }
  clone() {
    cloned++;
    if (mode === 'clone-fail') throw Error('clone fault');
    return new Frame(this.timestamp);
  }
}
class Decoder {
  static async isConfigSupported() {
    return { supported: true };
  }
  constructor(callbacks) {
    constructed++;
    if (mode === 'construct-fail') throw Error('construct fault');
    this.callbacks = callbacks;
    lastOutput = callbacks.output;
    this.state = 'unconfigured';
  }
  configure() {
    this.state = 'configured';
  }
  decode(chunk) {
    if (mode === 'decode-fail') throw Error('decode fault');
    this.callbacks.output(new Frame(chunk.timestamp));
  }
  flush() {
    if (mode === 'abort-flush') {
      decoding();
      return new Promise(() => {});
    }
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
  }
}
globalThis.VideoDecoder = Decoder;
globalThis.EncodedVideoChunk = class {
  constructor(c) {
    Object.assign(this, c);
  }
};
const module = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
);
const realm = globalThis[Symbol.for('editor-platform.private.decoded-frame-budget.v1')];
const unit = 1920 * 1112;
const zero = () => {
  assert.equal(open, 0);
  assert.deepEqual(module.videoStatus(), { sessions: 0 });
  assert.deepEqual(realm.snapshot(), { pixels: 0, bytes: 0 });
};
const make = (signal) => module.createVideoWindow(new globalThis.Blob([]), signal, 'iphone-sdr-v1');
const raw = (n) => ({ value: n, timescale: 25 });
const rows = [];
try {
  for (const fault of ['construct-fail', 'decode-fail', 'clone-fail']) {
    mode = fault;
    const c = new globalThis.AbortController(),
      owner = await make(c.signal);
    await assert.rejects(owner.frameAt(raw(0), c.signal), /fault/);
    await owner.dispose();
    if (fault === 'decode-fail') lastOutput(new Frame(0));
    zero();
    rows.push(fault);
  }
  mode = undefined;
  const c = new globalThis.AbortController(),
    a = await make(c.signal),
    b = await make(c.signal);
  const first = await a.frameAt(raw(0), c.signal),
    second = await b.frameAt(raw(64), c.signal);
  assert.equal(realm.snapshot().pixels, unit * 130);
  let finished = false;
  const closing = a.dispose().then(() => {
    finished = true;
  });
  await new Promise((r) => globalThis.setTimeout(r, 0));
  assert.equal(finished, false);
  assert.equal(realm.snapshot().pixels, unit * 66);
  first.release();
  first.release();
  await closing;
  second.release();
  await b.dispose();
  zero();
  rows.push('two-source-and-outstanding-clone-drain');
  const owner = await make(c.signal),
    blocker = realm.session({ pixels: unit * 132, bytes: unit * 132 * 4 });
  let held = blocker.reserve({ pixels: unit * 100, bytes: unit * 100 * 4 }),
    before = constructed;
  await assert.rejects(owner.frameAt(raw(0), c.signal), /realm budget/);
  assert.equal(constructed, before);
  held.release();
  const kept = await owner.frameAt(raw(0), c.signal);
  kept.release();
  held = blocker.reserve({ pixels: unit * 68, bytes: unit * 68 * 4 });
  const clonesBefore = cloned;
  await assert.rejects(owner.frameAt(raw(0), c.signal), /realm budget/);
  assert.equal(cloned, clonesBefore);
  held.release();
  blocker.close();
  await owner.dispose();
  zero();
  rows.push('pre-decoder-and-pre-clone-realm-refusal');
  mode = 'abort-flush';
  const cancel = new globalThis.AbortController(),
    active = await make(cancel.signal);
  const entered = new Promise((r) => {
    decoding = r;
  });
  const pending = active.frameAt(raw(0), cancel.signal);
  const rejected = assert.rejects(pending);
  await entered;
  cancel.abort();
  await rejected;
  await active.dispose();
  zero();
  rows.push('abort-during-flush');
  mode = undefined;
  const other = await import(
    'data:text/javascript;base64,' +
      Buffer.from(built.outputFiles[0].text + '\n//second-bundle').toString('base64')
  );
  const x = await make(c.signal),
    y = await make(c.signal);
  const x1 = await x.frameAt(raw(0), c.signal),
    x2 = await x.frameAt(raw(0), c.signal);
  const y1 = await y.frameAt(raw(0), c.signal),
    y2 = await y.frameAt(raw(0), c.signal);
  const z = await other.createVideoWindow(new globalThis.Blob([]), c.signal, 'iphone-sdr-v1');
  const constructors = constructed;
  await assert.rejects(z.frameAt(raw(0), c.signal), /realm budget/);
  assert.equal(constructed, constructors);
  x1.release();
  x2.release();
  y1.release();
  y2.release();
  await Promise.all([x.dispose(), y.dispose(), z.dispose()]);
  zero();
  assert.equal(other.videoStatus().sessions, 0);
  rows.push('independent-bundles-share-realm-before-decoder');
  console.log(JSON.stringify({ state: 'PASS', cases: rows, remaining: module.videoStatus() }));
} finally {
  globalThis.VideoDecoder = originalDecoder;
  globalThis.EncodedVideoChunk = originalChunk;
}
