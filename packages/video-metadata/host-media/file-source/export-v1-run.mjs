import { time } from '@editor-platform/video-core';
import { contentHash } from '@editor-platform/artifact-core';
import { inspectOriginalV1 } from './inspect-v1';
import { prepareImportSetV1 } from './import-v1';
import { productCodecV1 } from './product-codec-v1.mjs';
globalThis.exportV1Original = async () => {
  const original = globalThis.document.querySelector('#source').files[0],
    signal = new globalThis.AbortController().signal;
  original.arrayBuffer = () => {
    throw Error('Whole original buffer prohibited');
  };
  const { plan } = await inspectOriginalV1(original, signal);
  const content = prepareImportSetV1(
    {
      schema: 'video-core-prototype-v1',
      sources: [],
      sequence: {
        id: 'sequence',
        duration: time(0),
        frameRate: time(25),
        clips: [],
        tracks: [
          { id: 'visual', kind: 'visual', enabled: true, locked: false },
          { id: 'audio', kind: 'audio', enabled: true, locked: false },
        ],
      },
    },
    plan,
    {
      assetId: 'original',
      sha256: '69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4',
      byteLength: original.size,
    },
    'source',
  );
  const snapshot = {
    native: { content, revision: { kind: 'local', sessionId: 'test', sequence: 0 } },
    originals: [{ sourceId: 'source', bytes: original, plan }],
    hash: await contentHash(content),
  };
  const output = await productCodecV1.encode(snapshot, signal);
  await productCodecV1.verify(output, snapshot, signal);
  const a = globalThis.document.createElement('a');
  a.href = globalThis.URL.createObjectURL(output);
  a.download = 'full-v1.mp4';
  a.click();
  return { content, evidence: productCodecV1.provenance(output), size: output.size };
};
