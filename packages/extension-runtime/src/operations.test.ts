import { describe, expect, it, vi } from 'vitest';
import { EditorSession, command } from '@editor-platform/editor-core';
import { createArtifact } from '@editor-platform/artifact-core';
import { ArtifactEditor, type EditorHostAdapter } from '@editor-platform/editor-host';
import { artifactEditorHost } from './editor-host';
import {
  counterExtension,
  createCounter,
  isCounter,
  type Counter,
} from '@editor-platform/extension-sample';
import {
  OPERATIONS_ADDON,
  type ExtensionDefinition,
  type HostAdapter,
  type OperationDeclaration,
  type OperationsAdapter,
} from '@editor-platform/extension-contract';
import {
  ExtensionRegistry,
  OPERATION_LIMITS,
  operationDeclarationProblems,
  operationInputProblems,
  parseManifest,
} from './index';

const hash = `sha256:${'2'.repeat(64)}`;
const admission = { trust: 'trusted' as const, verifiedPackageHash: hash };
const SET: OperationDeclaration = {
  id: 'counter.set',
  version: '1.0.0',
  title: 'Set the counter',
  inputSchema: {
    type: 'object',
    properties: {
      before: {
        type: 'integer',
        minimum: 0,
        maximum: 1000,
        description: 'Value the change expects',
      },
      value: { type: 'integer', minimum: 0, maximum: 1000 },
    },
    required: ['before', 'value'],
    additionalProperties: false,
  },
};
const ref = { id: 'counter.set', version: '1.0.0' };
type SetInput = { before: number; value: number };
const adapter = (over: Partial<OperationsAdapter<Counter>> = {}): OperationsAdapter<Counter> => ({
  checkInput: (_op, input, content) =>
    (input as SetInput).before === content.value ? [] : ['counter changed'],
  command: (_op, input) => {
    const { before, value } = input as SetInput;
    return command<Counter>('counter.set', 'Set counter', (c) => {
      if (c.value !== before) throw new Error('counter changed');
      return { ...c, value };
    });
  },
  ...over,
});
function withOperations(
  over: Partial<OperationsAdapter<Counter>> = {},
  declarations = [SET],
): ExtensionDefinition<Counter> {
  const base = counterExtension(hash);
  return {
    ...base,
    manifest: {
      ...base.manifest,
      addons: { operations: { version: OPERATIONS_ADDON, declarations } },
    },
    operations: adapter(over),
  };
}
function fixture(definition = withOperations()) {
  const registration = new ExtensionRegistry().install(definition, admission);
  const session = new EditorSession(createCounter());
  const host: HostAdapter<Counter> = {
    artifactKind: 'example.counter',
    schemaVersion: 1,
    allowed: () => true,
    readOnly: () => false,
    read: () => session.content,
    execute: (c) => void session.execute(c),
    undo: () => void session.undo(),
    redo: () => void session.redo(),
    save: vi.fn(async () => {}),
    select: vi.fn(),
  };
  const handle = registration.open(host);
  const state = () => ({
    value: session.content.value,
    revision: session.revision,
    undo: session.canUndo,
    redo: session.canRedo,
    proposals: session.proposalTransactions,
  });
  return { registration, session, handle, state };
}

describe('operations@0-draft declarations', () => {
  it('accepts the bounded schema subset and keeps manifests without add-ons unchanged', () => {
    expect(
      operationDeclarationProblems({ version: OPERATIONS_ADDON, declarations: [SET] }),
    ).toEqual([]);
    const plain = parseManifest(counterExtension(hash).manifest);
    expect('addons' in plain).toBe(false);
    const declared = parseManifest(withOperations().manifest);
    expect(declared.addons?.operations?.declarations[0].id).toBe('counter.set');
    expect(Object.isFrozen(declared.addons!.operations!.declarations[0].inputSchema)).toBe(true);
  });
  it('refuses unknown versions, keywords, unbounded strings/arrays, open objects, depth and count limits', () => {
    const problems = (declarations: unknown, version: unknown = OPERATIONS_ADDON) =>
      operationDeclarationProblems({ version, declarations });
    expect(problems([SET], 'operations@1')).toEqual([
      'unsupported operations add-on version operations@1',
    ]);
    expect(
      operationDeclarationProblems({ version: OPERATIONS_ADDON, declarations: [SET], extra: 1 }),
    ).toHaveLength(1);
    const schema = (s: unknown) =>
      problems([
        {
          ...SET,
          inputSchema: { type: 'object', properties: { x: s }, additionalProperties: false },
        },
      ]);
    expect(schema({ type: 'string' })[0]).toMatch(/maxLength is required/);
    expect(schema({ type: 'string', maxLength: 10, pattern: '.*' })[0]).toMatch(
      /unsupported keyword pattern/,
    );
    expect(schema({ $ref: '#/x' })[0]).toMatch(/unsupported schema type/);
    // Inherited names are not schema types: they are refused, not looked up on Object.prototype.
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(schema(JSON.parse(`{"type":${JSON.stringify(type)}}`))).toEqual([
        'operations[0].inputSchema.x: unsupported schema type',
      ]);
    expect(schema({ type: 'array', items: { type: 'null' } })[0]).toMatch(/maxItems is required/);
    expect(schema({ type: 'string', maxLength: OPERATION_LIMITS.maxLength + 1 })[0]).toMatch(
      /maxLength is required/,
    );
    expect(schema({ type: 'object', properties: {}, additionalProperties: true })[0]).toMatch(
      /additionalProperties: false/,
    );
    let deep: unknown = { type: 'null' };
    for (let i = 0; i < OPERATION_LIMITS.depth; i++)
      deep = { type: 'array', items: deep, maxItems: 1 };
    expect(schema(deep).some((p) => /nested too deeply/.test(p))).toBe(true);
    const many = Array.from({ length: OPERATION_LIMITS.operations + 1 }, (_, i) => ({
      ...SET,
      id: `op.${i}`,
    }));
    expect(problems(many)).toEqual([
      `declarations must list 1-${OPERATION_LIMITS.operations} operations`,
    ]);
    expect(problems([SET, SET]).some((p) => /duplicate id/.test(p))).toBe(true);
    const big = { ...SET, title: 'x'.repeat(OPERATION_LIMITS.text) };
    expect(
      problems(
        Array.from({ length: 16 }, (_, i) => ({
          ...big,
          id: `op.${i}`,
          inputSchema: { ...SET.inputSchema, description: 'y'.repeat(500) },
        })),
      ),
    ).toEqual([]);
    const wide = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [
          `p${i}`,
          { type: 'string', maxLength: 1, description: 'z'.repeat(500) },
        ]),
      ),
      additionalProperties: false,
    };
    expect(problems([{ ...SET, inputSchema: wide }])).toEqual([
      'operation declarations are too large',
    ]);
    expect(() =>
      parseManifest({
        ...withOperations().manifest,
        addons: { operations: { version: 'operations@9', declarations: [SET] } },
      }),
    ).toThrow(/Invalid operations add-on/);
    expect(() => parseManifest({ ...withOperations().manifest, addons: { other: {} } })).toThrow(
      /Unsupported add-ons/,
    );
  });
  it('checks one input as data, by exact operation id and version, without package code', () => {
    const d = [SET];
    expect(operationInputProblems(d, ref, { before: 0, value: 5 })).toEqual([]);
    expect(operationInputProblems(d, { id: 'counter.reset', version: '1.0.0' }, {})).toEqual([
      'undeclared operation counter.reset',
    ]);
    expect(operationInputProblems(d, { id: 'counter.set', version: '2.0.0' }, {})).toEqual([
      'operation counter.set is 1.0.0, not 2.0.0',
    ]);
    expect(operationInputProblems(d, ref, { before: 0 })).toEqual(['input: missing value']);
    expect(operationInputProblems(d, ref, { before: 0, value: 5, path: '/etc' })).toEqual([
      'input: unknown property path',
    ]);
    expect(operationInputProblems(d, ref, { before: 0, value: 1.5 })).toEqual([
      'input.value: expected an integer',
    ]);
    expect(operationInputProblems(d, ref, { before: 0, value: 2000 })).toEqual([
      'input.value: out of range',
    ]);
    const one = [
      {
        ...SET,
        inputSchema: {
          type: 'object' as const,
          properties: { t: { type: 'string' as const, maxLength: 1, minLength: 1 } },
          additionalProperties: false as const,
        },
      },
    ];
    // String lengths count code points: one emoji is one character, not two UTF-16 units.
    expect(operationInputProblems(one, ref, { t: '😀' })).toEqual([]);
    expect(operationInputProblems(one, ref, { t: '😀😀' })).toEqual(['input.t: wrong length']);
    expect(
      operationDeclarationProblems({
        version: OPERATIONS_ADDON,
        declarations: [
          {
            ...SET,
            inputSchema: {
              type: 'object',
              properties: { t: { type: 'string', maxLength: 1, enum: ['😀'] } },
              additionalProperties: false,
            },
          },
        ],
      }),
    ).toEqual([]);
    const text = [
      {
        ...SET,
        inputSchema: {
          type: 'object' as const,
          properties: { t: { type: 'string' as const, maxLength: 30000 } },
          additionalProperties: false as const,
        },
      },
    ];
    expect(
      operationInputProblems(text, ref, { t: 'x'.repeat(OPERATION_LIMITS.inputBytes) }),
    ).toEqual(['input is too large']);
  });
});

describe('operations@0-draft registration and prepare/commit', () => {
  it('requires the adapter exactly when the manifest declares the add-on', () => {
    const r = new ExtensionRegistry();
    const { operations: _ops, ...noAdapter } = withOperations();
    expect(() => r.install(noAdapter, admission)).toThrow('Operations add-on/adapter mismatch');
    expect(() =>
      r.install({ ...counterExtension(hash), operations: adapter() }, admission),
    ).toThrow('Operations add-on/adapter mismatch');
    const def = withOperations();
    expect(() =>
      r.install({ ...def, manifest: { ...def.manifest, capabilities: ['surface'] } }, admission),
    ).toThrow('Operations require local-edit');
    expect(
      fixture(counterExtension(hash) as ExtensionDefinition<Counter>).handle.operations,
    ).toBeUndefined();
  });
  it('commits exactly the checked candidate as one history entry with the Host context', () => {
    const { handle, session, state } = fixture();
    expect(handle.operations!.check(ref, { before: 0, value: 5 })).toEqual([]);
    expect(handle.operations!.check(ref, { before: 3, value: 5 })).toEqual(['counter changed']);
    const prepared = handle.operations!.prepare(ref, { before: 0, value: 5 });
    expect(prepared.base.value).toBe(0);
    expect(prepared.candidate.value).toBe(5);
    expect(Object.isFrozen(prepared.candidate)).toBe(true);
    expect(session.content.value).toBe(0);
    prepared.commit({ origin: 'proposal', transactionId: 'host-tx-1' });
    expect(state()).toMatchObject({ value: 5, undo: true, proposals: ['host-tx-1'] });
    expect(() => prepared.commit()).toThrow('Operation already committed');
    session.undo();
    expect(state()).toMatchObject({ value: 0, proposals: [] });
    session.redo();
    expect(state()).toMatchObject({ value: 5, proposals: ['host-tx-1'] });
  });
  it('calls the package apply once; a different later result never reaches history', () => {
    let calls = 0;
    const { handle, session } = fixture(
      withOperations({
        command: () =>
          command<Counter>('counter.set', 'Set', (c) => ({
            ...c,
            value: ++calls === 1 ? 5 : 2000,
          })),
      }),
    );
    const prepared = handle.operations!.prepare(ref, { before: 0, value: 5 });
    prepared.commit();
    expect(calls).toBe(1);
    expect(session.content.value).toBe(5);
    expect(isCounter(session.content)).toBe(true);
  });
  it('refusals leave content, every history branch and dirty revision unchanged', () => {
    const { handle, session, state } = fixture();
    handle.api.execute(command<Counter>('counter.set', 'Set', (c) => ({ ...c, value: 1 })));
    handle.api.execute(command<Counter>('counter.set', 'Set', (c) => ({ ...c, value: 2 })));
    session.undo(); // a redo branch (value 2) exists
    const before = state();
    // input refused by the schema or the package check
    expect(() => handle.operations!.prepare(ref, { before: 1, value: 'x' })).toThrow(
      /Operation input refused/,
    );
    expect(() => handle.operations!.prepare(ref, { before: 0, value: 3 })).toThrow(
      /counter changed/,
    );
    // result refused by the package validator
    const bad = fixture(
      withOperations({
        command: () => command<Counter>('counter.set', 'Set', (c) => ({ ...c, value: -1 })),
      }),
    );
    expect(() => bad.handle.operations!.prepare(ref, { before: 0, value: 3 })).toThrow(
      'Invalid domain content',
    );
    expect(bad.state()).toMatchObject({ value: 0, undo: false, redo: false });
    // a prepared operation commits later only while the base is unchanged
    const prepared = handle.operations!.prepare(ref, { before: 1, value: 9 });
    expect(state()).toEqual(before);
    const other = fixture();
    const stale = other.handle.operations!.prepare(ref, { before: 0, value: 9 });
    other.handle.api.execute(command<Counter>('counter.set', 'Set', (c) => ({ ...c, value: 4 })));
    other.session.undo();
    other.handle.api.execute(command<Counter>('counter.set', 'Set', (c) => ({ ...c, value: 6 })));
    const otherBefore = other.state();
    expect(() => stale.commit()).toThrow('Operation base changed');
    expect(other.state()).toEqual(otherBefore);
    expect(session.canRedo).toBe(true);
    prepared.commit();
    expect(session.content.value).toBe(9);
  });
  it('a synchronous Host notification cannot re-enter commit: one execute, one revision, one proposal', () => {
    const counterHost: EditorHostAdapter<Counter> = {
      kind: 'example.counter',
      validate: isCounter,
      capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
    };
    const editor = new ArtifactEditor(
      createArtifact<Counter>('example.counter', 'Counter', createCounter()),
      counterHost,
      { put: async () => {} },
    );
    const real = artifactEditorHost(editor, { schemaVersion: 1, allowed: () => true });
    const execute = vi.fn(real.execute);
    const host: HostAdapter<Counter> = { ...real, execute };
    const registration = new ExtensionRegistry().install(withOperations(), admission);
    const handle = registration.open(host);
    const revision = editor.revision;
    // candidate equals base (set 0 to 0), so a re-entered commit would also pass the base check
    const prepared = handle.operations!.prepare(ref, { before: 0, value: 0 });
    const reentry: unknown[] = [];
    let depth = 0;
    editor.attach(() => {
      if (depth++ > 3) return;
      try {
        prepared.commit({ origin: 'proposal', transactionId: 'tx-same' });
      } catch (e) {
        reentry.push((e as Error).message);
      }
    });
    prepared.commit({ origin: 'proposal', transactionId: 'tx-same' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reentry).toEqual(['Operation already committed']);
    expect(editor.revision).not.toEqual(revision);
    expect(editor.proposalTransactions).toEqual(['tx-same']);
    expect(editor.canUndo).toBe(true);
    editor.undo();
    expect(editor.proposalTransactions).toEqual([]);
    expect(editor.canUndo).toBe(false);
  });
  it('a failed commit consumes the prepared operation; the Host prepares again', () => {
    const { handle, session, state } = fixture();
    const stale = handle.operations!.prepare(ref, { before: 0, value: 9 });
    handle.api.execute(command<Counter>('counter.set', 'Set', (c) => ({ ...c, value: 4 })));
    session.undo(); // content equals the base again, with a redo branch
    handle.api.execute(command<Counter>('counter.set', 'Set', (c) => ({ ...c, value: 6 })));
    expect(() => stale.commit()).toThrow('Operation base changed');
    session.undo(); // back to the base content
    const before = state();
    expect(() => stale.commit()).toThrow('Operation already committed');
    expect(state()).toEqual(before);
    handle.operations!.prepare(ref, { before: 0, value: 9 }).commit();
    expect(session.content.value).toBe(9);
  });
  it('closed handles and revoked registrations refuse check, prepare and commit', () => {
    const a = fixture();
    const prepared = a.handle.operations!.prepare(ref, { before: 0, value: 5 });
    a.handle.close();
    expect(() => a.handle.operations!.check(ref, { before: 0, value: 5 })).toThrow('Handle closed');
    expect(() => prepared.commit()).toThrow('Handle closed');
    const b = fixture();
    const p2 = b.handle.operations!.prepare(ref, { before: 0, value: 5 });
    b.registration.uninstall();
    expect(() => p2.commit()).toThrow('Registration revoked');
    expect(b.session.content.value).toBe(0);
  });
});
