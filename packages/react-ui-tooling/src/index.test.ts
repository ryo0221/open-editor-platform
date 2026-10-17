import { expect, it } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';
import {
  extractReactRegistrationCandidates,
  reactExtractionPolicyKey,
  type ReactExtractionRequest,
  validateReactExtractionRequest,
} from './index';
const file = resolve('apps/react-ui-reference/src/components.tsx');
const program = ts.createProgram([file], {
  strict: true,
  skipLibCheck: true,
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
});
const request: ReactExtractionRequest = {
  sourceRevision: 'reference-source-1',
  entries: ['Card', 'Button', 'Text', 'Image', 'Input'].map((exportName) => ({
    file,
    exportName,
    ref: {
      registryId: 'extracted-reference',
      componentId: exportName,
      version: '1.0.0',
      implementationHash: 'a'.repeat(64),
    },
    import: { source: '@reference/ui', export: 'named', name: exportName },
  })),
};
it('extracts actual five reference component types without importing/executing implementations', () => {
  const result = extractReactRegistrationCandidates(program, request);
  expect(result.diagnostics).toEqual([]);
  expect(result.candidates).toHaveLength(5);
  const card = result.candidates[0].proposed,
    button = result.candidates[1].proposed;
  expect(card.slots.children.minimum).toBe(0);
  expect(card.slots.footer.prop).toBe('footer');
  expect(button.props.variant.schema).toEqual({ type: 'enum', values: ['primary', 'secondary'] });
  expect(button.events.onPress).toEqual({ parameters: [], returns: 'void' });
  expect(result.candidates.every((c) => c.review === 'unreviewed')).toBe(true);
  expect(Object.isFrozen(card.props)).toBe(true);
});
it('Host policy controls sample/exclusion/wrapper without modifying source or other candidates', () => {
  const cardKey = reactExtractionPolicyKey(request.entries[0].ref),
    buttonKey = reactExtractionPolicyKey(request.entries[1].ref);
  const result = extractReactRegistrationCandidates(program, {
    ...request,
    policies: {
      [cardKey]: { layout: 'wrapper' },
      [buttonKey]: { sampleProps: { label: 'Host sample' } },
      [reactExtractionPolicyKey(request.entries[4].ref)]: { exclude: true },
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.excluded).toHaveLength(1);
  expect(result.candidates[0].proposed.layout).toBe('wrapper');
  expect(result.candidates[1].proposed.sampleProps.label).toBe('Host sample');
  expect(extractReactRegistrationCandidates(program, request).candidates[0].proposed.layout).toBe(
    'className',
  );
  expect(() =>
    extractReactRegistrationCandidates(program, {
      ...request,
      policies: { unknown: { exclude: true } },
    }),
  ).toThrow(/unknown component/);
});
function fixture(source: string) {
  const name = resolve('work/issue-38/type-fixture.tsx');
  const host = ts.createCompilerHost({});
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (path, language, onError, fresh) =>
    path === name
      ? ts.createSourceFile(path, source, language, true, ts.ScriptKind.TSX)
      : read(path, language, onError, fresh);
  const p = ts.createProgram(
    [name],
    {
      strict: true,
      skipLibCheck: true,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
    },
    host,
  );
  return {
    p,
    entry: {
      ...request.entries[0],
      file: name,
      exportName: 'Tile',
      ref: { ...request.entries[0].ref, componentId: 'Tile' },
    },
  };
}
it.each([
  ['value: string | undefined', 'unsupported-union'],
  ['data: { value: number | undefined }', 'unsupported-union'],
  ['onSubmit: () => void', 'required-callback'],
  ['onSubmit: ((value: string) => void) | undefined', 'required-callback'],
  ['onPick?: (value: string | number) => void', 'unsupported-union'],
  ['data: { label: import("react").ReactNode }', 'nested-react-node'],
  ['onPick?: (value?: string) => void', 'callback-arguments'],
  ['onPick?: (value: string | undefined) => void', 'callback-arguments'],
  ['onPick?: (value: string) => boolean', 'callback-signature'],
  ['data: any', 'unsupported-type'],
  ['data: Record<string,string>', 'unsupported-type'],
])('diagnoses unsupported shape %s with component, addressed prop and recovery', (shape, code) => {
  const { p, entry } = fixture(
    `export function Tile(props: {${shape}}) { return <p>Independent tile</p>; }`,
  );
  const result = extractReactRegistrationCandidates(p, {
    sourceRevision: 'independent-v1',
    entries: [entry],
  });
  expect(result.candidates).toEqual([]);
  expect(result.diagnostics[0]).toMatchObject({ code, severity: 'error' });
  expect(result.diagnostics[0].message).toContain('Tile.');
  expect(result.diagnostics[0].recovery).toContain('Host');
});

it('preserves optional undefined props and nested fields without narrowing required fields', () => {
  const { p, entry } = fixture(
    'export function Tile(props: { value?: string | undefined; data: { value?: number | undefined } }) { return <p>{props.value}</p>; }',
  );
  const result = extractReactRegistrationCandidates(p, {
    sourceRevision: 'optional-v1',
    entries: [entry],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.candidates[0].proposed.props.value).toEqual({
    required: false,
    schema: { type: 'string' },
  });
  expect(result.candidates[0].proposed.props.data.schema).toEqual({
    type: 'object',
    fields: { value: { required: false, schema: { type: 'number' } } },
  });
});
it.each(['{ value: "opaque object" }', '() => "function"', 'Symbol("not a node")'])(
  'diagnoses a non-renderable component return %s',
  (value) => {
    const { p, entry } = fixture('export function Tile() { return ' + value + '; }');
    const result = extractReactRegistrationCandidates(p, {
      sourceRevision: 'returns-v1',
      entries: [entry],
    });
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ code: 'component-return' });
  },
);
it.each(['null', '"renderable text"', '[<p key="one">one</p>]', '<p>element</p>'])(
  'accepts React-renderable component return %s',
  (value) => {
    const { p, entry } = fixture('export function Tile() { return ' + value + '; }');
    const result = extractReactRegistrationCandidates(p, {
      sourceRevision: 'returns-v1',
      entries: [entry],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.candidates).toHaveLength(1);
  },
);
it('runtime request validator rejects unknown/missing fields through every metadata boundary', () => {
  const entry = request.entries[0];
  const key = reactExtractionPolicyKey(entry.ref);
  const invalid: unknown[] = [
    { ...request, policy: {} },
    { ...request, entries: [{ ...entry, require: ['theme'] }] },
    { ...request, entries: [{ ...entry, ref: { ...entry.ref, revision: 'typo' } }] },
    { ...request, entries: [{ ...entry, import: { ...entry.import, exportName: 'typo' } }] },
    { ...request, policies: { [key]: { sampleProp: {} } } },
    {
      ...request,
      policies: {
        [key]: {
          slots: {
            children: {
              prop: 'children',
              minimum: 0,
              maximum: 1,
              accepts: [{ registryId: 'x', componentId: 'x', extra: true }],
            },
          },
        },
      },
    },
    {
      ...request,
      policies: {
        [key]: {
          controlledInputs: [
            { valueProp: 'value', eventProp: 'onChange', argumentIndex: 0, extra: true },
          ],
        },
      },
    },
    { ...request, entries: [{ file: entry.file, exportName: 'Card', ref: entry.ref }] },
    {
      ...request,
      entries: [{ ...entry, ref: { ...entry.ref, implementationHash: 'invalid' } }],
      policies: { [key]: { exclude: true } },
    },
  ];
  for (const value of invalid) expect(() => validateReactExtractionRequest(value)).toThrow();
  expect(() => validateReactExtractionRequest(request)).not.toThrow();
});
it('a locally shadowed React namespace cannot make an opaque object renderable', () => {
  const { p, entry } = fixture(
    'namespace React { export type ReactNode = { opaque: string }; } export function Tile(): React.ReactNode { return { opaque: "object" }; }',
  );
  const result = extractReactRegistrationCandidates(p, {
    sourceRevision: 'shadowed-v1',
    entries: [entry],
  });
  expect(result.candidates).toEqual([]);
  expect(result.diagnostics[0]).toMatchObject({ code: 'component-return' });
});
it('extracts independent nested JSON, enum callback and explicit wrapper policy', () => {
  const { p, entry } = fixture(
    'export function Tile(props: { data: { label: string; active?: boolean }; items: string[]; onPick?: (value: "open" | "done") => void }) { return <p>{props.data.label}</p>; }',
  );
  const result = extractReactRegistrationCandidates(p, {
    sourceRevision: 'independent-v1',
    entries: [entry],
    policies: {
      [reactExtractionPolicyKey(entry.ref)]: {
        layout: 'wrapper',
        sampleProps: { data: { label: 'Independent' }, items: [] },
      },
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.candidates[0].proposed.events.onPick.parameters[0]).toEqual({
    type: 'enum',
    values: ['done', 'open'],
  });
  expect(result.candidates[0].proposed.layout).toBe('wrapper');
});

it('rejects numeric literal contracts instead of creating an unrestricted number sample', () => {
  const { p, entry } = fixture(
    'export function Tile(props: { columns: 3 }) { return <p>{props.columns}</p>; }',
  );
  const r = extractReactRegistrationCandidates(p, {
    sourceRevision: 'literal-v1',
    entries: [entry],
  });
  expect(r.candidates).toEqual([]);
  expect(r.diagnostics[0]).toMatchObject({
    code: 'unsupported-numeric-literal',
    path: expect.stringContaining('columns'),
  });
});
it.each(['string', '{ color?: string }', 'React.CSSProperties & { required: string }'])(
  'rejects incompatible style layout %s',
  (style) => {
    const { p, entry } = fixture(
      `import type * as React from 'react';export function Tile(props: { style?: ${style} }) { return <p/>; }`,
    );
    const r = extractReactRegistrationCandidates(p, {
      sourceRevision: 'style-v1',
      entries: [entry],
      policies: { [reactExtractionPolicyKey(entry.ref)]: { layout: 'style' } },
    });
    expect(r.candidates).toEqual([]);
    expect(r.diagnostics[0].code).toBe('host-layout-policy');
  },
);
it('accepts actual React CSSProperties style layout', () => {
  const { p, entry } = fixture(
    "import type { CSSProperties as Style } from 'react';export function Tile(props: { style?: Style }) { return <p style={props.style}/>; }",
  );
  const r = extractReactRegistrationCandidates(p, {
    sourceRevision: 'style-v1',
    entries: [entry],
    policies: { [reactExtractionPolicyKey(entry.ref)]: { layout: 'style' } },
  });
  expect(r.diagnostics).toEqual([]);
  expect(r.candidates[0].proposed.layout).toBe('style');
});
it.each(['ReactNode', 'ReactElement', 'ReactPortal', 'ReactChild'])(
  'keeps a local JSON type named %s as data',
  (name) => {
    const { p, entry } = fixture(
      `type ${name}={label:string};export function Tile(props:{data:${name}}){return <p>{props.data.label}</p>;}`,
    );
    const r = extractReactRegistrationCandidates(p, {
      sourceRevision: 'identity-v1',
      entries: [entry],
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.candidates[0].proposed.props.data.schema.type).toBe('object');
    expect(r.candidates[0].proposed.slots).toEqual({});
  },
);
it('recognizes an imported React slot alias and prevents policy lowering its required minimum', () => {
  const { p, entry } = fixture(
    "import type {ReactNode as Child} from 'react';export function Tile(props:{children:Child}){return <div>{props.children}</div>;}",
  );
  const input = { sourceRevision: 'slot-v1', entries: [entry] };
  const original = extractReactRegistrationCandidates(p, input);
  expect(original.diagnostics).toEqual([]);
  const slot = original.candidates[0].proposed.slots.children;
  expect(slot.minimum).toBe(1);
  const lowered = extractReactRegistrationCandidates(p, {
    ...input,
    policies: {
      [reactExtractionPolicyKey(entry.ref)]: { slots: { children: { ...slot, minimum: 0 } } },
    },
  });
  expect(lowered.candidates).toEqual([]);
  expect(lowered.diagnostics[0].code).toBe('host-slot-policy');
  const retained = extractReactRegistrationCandidates(p, {
    ...input,
    policies: {
      [reactExtractionPolicyKey(entry.ref)]: { slots: { children: { ...slot, maximum: 2 } } },
    },
  });
  expect(retained.diagnostics).toEqual([]);
});
