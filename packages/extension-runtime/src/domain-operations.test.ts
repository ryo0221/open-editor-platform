import type { DocumentContent } from '@editor-platform/document/model';
import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  CONTRACT_VERSION,
  OPERATIONS_ADDON,
  type OperationsAdapter,
  type OperationDeclaration,
} from '@editor-platform/extension-contract';
import {
  documentHostAdapter,
  documentOperations,
  documentOperationDeclarations,
} from '@editor-platform/document/native-host';
import {
  designHostAdapter,
  designOperations,
  designOperationDeclarations,
} from '@editor-platform/design/native-host';
import { createDesign, makeDesignElement } from '@editor-platform/design/model';
import { ExtensionRegistry, operationInputProblems } from './index';
import type { EditorHostAdapter } from '@editor-platform/editor-host';
const hash = `sha256:${'3'.repeat(64)}`;
const ref = { id: 'text.replace', version: '1.0.0' };
function open<T>(
  content: T,
  adapter: EditorHostAdapter<T>,
  operations: OperationsAdapter<T>,
  declarations: readonly OperationDeclaration[],
) {
  let trusted = true;
  const registration = new ExtensionRegistry().install(
    {
      manifest: {
        contractVersion: CONTRACT_VERSION,
        id: `test.${adapter.kind}`,
        version: '1.0.0',
        artifactKind: adapter.kind,
        schemaVersion: 1,
        packageHash: hash,
        capabilities: ['local-edit'],
        permissions: ['artifact:read', 'artifact:write'],
        licenseNotices: [],
        addons: { operations: { version: OPERATIONS_ADDON, declarations } },
      },
      validate: adapter.validate,
      operations,
    },
    {
      trust: 'trusted',
      verifiedPackageHash: hash,
      assertTrusted: () => {
        if (!trusted) throw Error('Pin revoked');
      },
    },
  );
  const session = new EditorSession(content);
  const handle = registration.open({
    artifactKind: adapter.kind,
    schemaVersion: 1,
    allowed: () => true,
    readOnly: () => false,
    read: () => session.content,
    execute: (c) => void session.execute(c),
    undo: () => void session.undo(),
    redo: () => void session.redo(),
    save: async () => {},
    select: () => {},
  });
  return {
    session,
    handle,
    revoke: () => {
      trusted = false;
    },
  };
}
const doc = (): DocumentContent => ({
  schemaVersion: 2 as const,
  blocks: [
    { id: 'body', type: 'paragraph' as const, text: 'before' },
    { id: 'other', type: 'paragraph' as const, text: 'keep' },
  ],
});
describe('domain operations share the H3 registration contract', () => {
  it('Document uses declared operations, native text command, one proposal transaction and Undo/Redo', () => {
    const f = open(doc(), documentHostAdapter, documentOperations, documentOperationDeclarations);
    const input = { selector: 'body', before: 'before', after: 'one\ntwo' };
    expect(operationInputProblems(documentOperationDeclarations, ref, input)).toEqual([]);
    const p = f.handle.operations!.prepare(ref, input);
    expect(f.session.content).toEqual(doc());
    p.commit({ origin: 'proposal', transactionId: 'host-doc' });
    expect(f.session.content.blocks[0].text).toBe('one\ntwo');
    expect(f.session.content.blocks[1].text).toBe('keep');
    expect(f.session.proposalTransactions).toEqual(['host-doc']);
    f.session.undo();
    expect(f.session.content).toEqual(doc());
    expect(f.session.proposalTransactions).toEqual([]);
    f.session.redo();
    expect(f.session.proposalTransactions).toEqual(['host-doc']);
  });
  it('Design uses the same operation without Host model parsing, preserving layout and other elements', () => {
    const c = createDesign();
    c.elements.push(
      { ...makeDesignElement('text'), id: 'body', text: 'before' },
      { ...makeDesignElement('rectangle'), id: 'other' },
    );
    const f = open(c, designHostAdapter, designOperations, designOperationDeclarations);
    f.handle
      .operations!.prepare(ref, { selector: 'body', before: 'before', after: 'after' })
      .commit({ origin: 'proposal', transactionId: 'host-design' });
    expect(f.session.content.elements[0]).toEqual({ ...c.elements[0], text: 'after' });
    expect(f.session.content.elements[1]).toEqual(c.elements[1]);
    f.session.undo();
    expect(f.session.content).toEqual(c);
    f.session.redo();
    expect(f.session.proposalTransactions).toEqual(['host-design']);
  });
  it('wrong operation/version/input, rich or stale target and revoked pin leave history intact', () => {
    const f = open(doc(), documentHostAdapter, documentOperations, documentOperationDeclarations);
    const input = { selector: 'body', before: 'before', after: 'after' };
    f.handle.operations!.prepare(ref, input).commit();
    f.session.undo();
    const revision = f.session.revision;
    for (const [op, value] of [
      [{ ...ref, id: 'unknown' }, input],
      [{ ...ref, version: '2.0.0' }, input],
      [ref, { ...input, after: 3 }],
      [ref, { ...input, before: 'stale' }],
    ] as const)
      expect(() => f.handle.operations!.prepare(op, value)).toThrow();
    expect(f.session.content).toEqual(doc());
    expect(f.session.revision).toEqual(revision);
    expect(f.session.canRedo).toBe(true);
    const pending = f.handle.operations!.prepare(ref, input);
    f.revoke();
    expect(() => pending.commit()).toThrow('Pin revoked');
    expect(f.session.revision).toEqual(revision);
    expect(f.session.canRedo).toBe(true);
    const rich: DocumentContent = {
      ...doc(),
      blocks: [{ ...doc().blocks[0], rich: [{ text: 'before', bold: true }] }],
    };
    const r = open(rich, documentHostAdapter, documentOperations, documentOperationDeclarations);
    expect(() => r.handle.operations!.prepare(ref, input)).toThrow('unsupported');
    expect(r.session.canUndo).toBe(false);
  });
});
