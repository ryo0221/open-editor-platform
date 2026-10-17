import { digest, options } from './portable-ui.mjs';
import { createAdmittedPersistenceV2 } from './storage-admission-v2.mjs';
import { contentHash } from '@editor-platform/artifact-core';
import { openPortableFile } from '../../file-backed-storage/browser-verifier/external-file';
import { blobReader } from '../../file-backed-storage/browser-verifier/adapter';
import { createScanner } from '../../file-backed-storage/portable/io';
import { createPortableProjects } from '../../file-backed-storage/portable/versioned';
import { createZip } from '../../file-backed-storage/portable/zip64';
const signal = () => new globalThis.AbortController().signal;
const selectedFile = () => globalThis.document.querySelector('#inspect').files[0];
globalThis.inspectPortableV2 = async () => {
  const opened = await openPortableFile(selectedFile(), digest, signal(), 256 * 1024 ** 2);
  try {
    return {
      kind: opened.kind,
      versions: globalThis.structuredClone(opened.project.versions),
      selectedVersionId: opened.project.selectedVersionId,
      capture: opened.project.capture,
      originals: [...opened.originals.keys()],
      receipt: opened.receipt,
    };
  } finally {
    opened.release();
  }
};
globalThis.makeStereoPortableV2 = async (retainedOnly, replaceOriginal = true) => {
  const opened = await openPortableFile(selectedFile(), digest, signal(), 256 * 1024 ** 2);
  try {
    const { originals, ...metadata } = opened.project;
    const project = { ...globalThis.structuredClone(metadata), originals: new Map(originals) };
    const stereo = globalThis.document.querySelector('#bad').files[0],
      scan = createScanner(digest),
      reader = blobReader(stereo),
      hash = (await scan(reader, signal())).sha256;
    const music = project.versions
      .flatMap((v) => v.content.sources)
      .find((s) => s.streams.every((t) => t.kind === 'audio'));
    if (!music) throw Error('Missing independent audio fixture');
    const oldHash = music.asset.sha256;
    for (const version of project.versions) {
      for (const source of version.content.sources)
        if (replaceOriginal && source.id === music.id)
          source.asset = { assetId: 'sha256:' + hash, sha256: hash, byteLength: stereo.size };
      if (retainedOnly && version.versionId === project.selectedVersionId) {
        version.content.sources = version.content.sources.filter((s) => s.id !== music.id);
        version.content.sequence.clips = version.content.sequence.clips.filter(
          (c) => c.sourceId !== music.id,
        );
      }
      version.contentHash = await contentHash(version.content);
    }
    project.capture.contentHash = project.versions.find(
      (v) => v.versionId === project.selectedVersionId,
    ).contentHash;
    if (replaceOriginal) {
      project.originals.delete(oldHash);
      project.originals.set(hash, reader);
    }
    const chunks = [],
      entries = await createPortableProjects(scan).v2.prepareProject(project, signal());
    await createZip(scan).writeZip(
      entries,
      { write: async (b) => chunks.push(Uint8Array.from(b)) },
      signal(),
    );
    const bytes = new globalThis.Blob(chunks),
      verified = await openPortableFile(bytes, digest, signal(), 256 * 1024 ** 2);
    let evidence;
    try {
      evidence = {
        receipt: verified.receipt,
        kind: verified.kind,
        retainedOnly,
        selectedHasMusic: verified.project.versions
          .find((v) => v.versionId === verified.project.selectedVersionId)
          .content.sources.some((s) => s.id === music.id),
      };
    } finally {
      verified.release();
    }
    if (!replaceOriginal) {
      const live = { originals: new Map(), plans: new Map() };
      const admitted = await createAdmittedPersistenceV2(options)(live, bytes);
      try {
        evidence.admitted = {
          selectedSources: admitted.content.sources.length,
          liveOriginals: live.originals.size,
          retainedOriginals: project.originals.size,
        };
      } finally {
        await admitted.close();
        live.originals.clear();
        live.plans.clear();
      }
    }
    const a = globalThis.document.createElement('a');
    a.href = globalThis.URL.createObjectURL(bytes);
    a.download = !replaceOriginal
      ? 'valid-retained.zip'
      : retainedOnly
        ? 'retained-stereo.zip'
        : 'selected-stereo.zip';
    a.click();
    return evidence;
  } finally {
    opened.release();
  }
};
