import { expect, it } from 'vitest';
import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { createAnimation2 } from '@editor-platform/animation-core/v2';
import { createVideoAnimationSources } from './animation-source';
const signal = () => new AbortController().signal;
it('resolves only exact saved versions and owns an immutable snapshot', async () => {
  const record = await commitVersion(
    createArtifact('animation', 'Native', createAnimation2()),
    null,
    null,
  );
  let allowed = true;
  const port = createVideoAnimationSources(
    { list: async () => [record], get: async () => record },
    () => allowed,
  );
  const [choice] = await port.list(signal());
  const lease = await port.retain(choice.source, signal());
  expect(Object.isFrozen(lease.snapshot)).toBe(true);
  record.draft.content.compositions[0].name = 'Changed draft';
  expect((lease.snapshot as typeof record.draft.content).compositions[0].name).not.toBe(
    'Changed draft',
  );
  expect(() => lease.assertAuthorized()).not.toThrow();
  allowed = false;
  expect(() => lease.assertAuthorized()).toThrow('permission');
  lease.release();
  allowed = true;
  expect(() => lease.assertAuthorized()).toThrow();
  await expect(port.retain({ ...choice.source, versionId: 'unknown' }, signal())).rejects.toThrow(
    'mismatch',
  );
});
it('refuses permission loss during asynchronous lookup and duplicate version identities', async () => {
  const record = await commitVersion(
    createArtifact('animation', 'Native', createAnimation2()),
    null,
    null,
  );
  let allowed = true;
  const port = createVideoAnimationSources(
    {
      list: async () => [record],
      get: async () => {
        allowed = false;
        return record;
      },
    },
    () => allowed,
  );
  const [choice] = await port.list(signal());
  await expect(port.retain(choice.source, signal())).rejects.toThrow('permission');
  const duplicate = { ...record, versions: [...record.versions, ...record.versions] };
  const duplicatePort = createVideoAnimationSources(
    { list: async () => [duplicate], get: async () => duplicate },
    () => true,
  );
  await expect(duplicatePort.retain(choice.source, signal())).rejects.toThrow('mismatch');
});
