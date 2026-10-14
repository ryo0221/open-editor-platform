import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial } from '@editor-platform/collaboration-core';
import { definitionRef } from '@editor-platform/reuse-core';
import {
  applyLocalTemplate,
  retainedComponent,
  reusableParts,
  templateCodec,
  validateNativeReusableDefinitions,
} from '@editor-platform/templates';
import {
  foreignVector,
  foreignVectorUpdateFixture,
} from '../../../tests/fixtures/design-reuse/foreign-vector-update';

for (const domain of ['slide', 'whiteboard'] as const)
  for (const change of ['change', 'delete'] as const) {
    it(`${domain} preserves opaque vector metadata when the adopted definition performs ${change}, through native reload`, async () => {
      const f = await foreignVectorUpdateFixture(domain, change);
      const before = clone(f.current);
      expect(f.preview.conflicts).toEqual([]);
      expect(f.preview.prepared).toBeDefined();
      expect(f.preview.changes.some((c) => c.field === 'vector')).toBe(false);
      const next = applyLocalTemplate(f.preview.prepared!, f.current);
      expect(reusableParts(next).get(f.address)).toMatchObject({
        vector: foreignVector,
        stroke: '#445566',
      });
      expect(retainedComponent(next, 'reuse_foreign').instance.ref).toEqual(
        definitionRef(f.definition),
      );
      const reopened = JSON.parse(JSON.stringify(next));
      expect(templateCodec(domain).validate(reopened)).toBe(true);
      await validateNativeReusableDefinitions(domain, reopened);
      expect(reopened).toEqual(next);
      expect(reusableParts(reopened).get(f.address)?.vector).toEqual(foreignVector);
      expect(f.current).toEqual(before);
    });
    it(`${domain} shared ${change} adoption and selective Undo keep opaque vector metadata`, async () => {
      const f = await foreignVectorUpdateFixture(domain, change);
      const codec = templateCodec(domain);
      const authority = new Authority(codec, initial('artifact', codec, f.current));
      const principal = { ...f.identity, writable: true, scopes: ['*'] };
      expect(authority.commit(principal, f.preview.prepared!.operation).status).toBe('accepted');
      expect(reusableParts(authority.snapshot().content).get(f.address)).toMatchObject({
        vector: foreignVector,
        stroke: '#445566',
      });
      expect(authority.undo(principal, f.preview.prepared!.operation.operationId).status).toBe(
        'accepted',
      );
      expect(reusableParts(authority.snapshot().content).get(f.address)).toMatchObject({
        vector: foreignVector,
        stroke: '#112233',
      });
      expect(retainedComponent(authority.snapshot().content, 'reuse_foreign').instance.ref).toEqual(
        retainedComponent(f.current, 'reuse_foreign').instance.ref,
      );
    });
  }
