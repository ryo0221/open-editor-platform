import ts from 'typescript';
import { deepFreeze } from '@editor-platform/artifact-core';
import {
  sealReactComponent,
  validateReactComponentRef,
  validateReactImport,
  validateReactJson,
  valueMatches,
  reactUiLimits,
  type RegisteredReactComponent,
  type ReactComponentRef,
  type ReactFieldSchema,
  type ReactValueSchema,
  type ReactSlotSchema,
  type JsonValue,
  type ReactUiDiagnostic,
  type ReactRegistrationCandidate,
} from '@editor-platform/react-ui-core';

export interface ReactExtractionEntry {
  file: string;
  exportName: string;
  name?: string;
  ref: Omit<ReactComponentRef, 'contractHash'>;
  import: RegisteredReactComponent['import'];
  requires?: string[];
}
export interface ReactExtractionPolicy {
  exclude?: boolean;
  sampleProps?: Record<string, JsonValue>;
  layout?: RegisteredReactComponent['layout'];
  slots?: Record<string, ReactSlotSchema>;
  controlledInputs?: RegisteredReactComponent['controlledInputs'];
}
export interface ReactExtractionRequest {
  sourceRevision: string;
  entries: ReactExtractionEntry[];
  /** Keys are exact registry/component IDs, encoded by reactExtractionPolicyKey. */
  policies?: Record<string, ReactExtractionPolicy>;
}
export const reactExtractionPolicyKey = (
  ref: Pick<ReactComponentRef, 'registryId' | 'componentId'>,
) => JSON.stringify([ref.registryId, ref.componentId]);
const absent = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
const members = (type: ts.Type) => (type.isUnion() ? type.types : [type]);
const concrete = (type: ts.Type) => members(type).filter((t) => !(t.flags & absent));
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function shape(raw: unknown, required: string[], optional: string[], path: string) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    required.some((key) => !Object.hasOwn(raw, key)) ||
    Object.keys(raw).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw Error('Invalid extraction request fields: ' + path);
  return raw as Record<string, unknown>;
}
function text(raw: unknown, path: string, maximum = 4096): asserts raw is string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > maximum)
    throw Error('Invalid extraction request string: ' + path);
}
/** Runtime boundary for JSON CLI and untyped Hosts, including excluded entries/policies. */
export function validateReactExtractionRequest(
  raw: unknown,
): asserts raw is ReactExtractionRequest {
  validateReactJson(raw);
  const request = shape(raw, ['sourceRevision', 'entries'], ['policies'], '$');
  text(request.sourceRevision, '$.sourceRevision', 512);
  if (
    !Array.isArray(request.entries) ||
    !request.entries.length ||
    request.entries.length > reactUiLimits.components
  )
    throw Error('Invalid extraction entrypoint list');
  for (const [index, value] of request.entries.entries())
    validateExtractionEntry(value, '$.entries.' + index);
  if (Object.hasOwn(request, 'policies')) validateExtractionPolicies(request.policies);
}
function validateExtractionEntry(value: unknown, path: string) {
  const entry = shape(value, ['file', 'exportName', 'ref', 'import'], ['name', 'requires'], path);
  text(entry.file, path + '.file');
  text(entry.exportName, path + '.exportName', 160);
  if (Object.hasOwn(entry, 'name')) text(entry.name, path + '.name', 160);
  const ref = shape(
    entry.ref,
    ['registryId', 'componentId', 'version', 'implementationHash'],
    [],
    path + '.ref',
  );
  validateReactComponentRef({ ...ref, contractHash: '0'.repeat(64) }, path + '.ref');
  validateReactImport(entry.import, path + '.import');
  if (
    Object.hasOwn(entry, 'requires') &&
    (!Array.isArray(entry.requires) ||
      entry.requires.length > reactUiLimits.dependencies ||
      entry.requires.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128))
  )
    throw Error('Invalid extraction dependencies: ' + path);
}
function validateExtractionPolicies(raw: unknown) {
  const policies = shape(raw, [], Object.keys(raw ?? {}), '$.policies');
  if (Object.keys(policies).length > reactUiLimits.components)
    throw Error('Too many extraction policies');
  for (const [key, value] of Object.entries(policies))
    validateExtractionPolicy(value, '$.policies.' + key);
}
function validateExtractionPolicy(value: unknown, path: string) {
  const policy = shape(
    value,
    [],
    ['exclude', 'sampleProps', 'layout', 'slots', 'controlledInputs'],
    path,
  );
  if (Object.hasOwn(policy, 'exclude') && typeof policy.exclude !== 'boolean')
    throw Error('Invalid Host extraction policy: ' + path);
  if (
    Object.hasOwn(policy, 'layout') &&
    !['none', 'className', 'style', 'wrapper'].includes(String(policy.layout))
  )
    throw Error('Invalid Host layout policy: ' + path);
  if (Object.hasOwn(policy, 'sampleProps'))
    shape(policy.sampleProps, [], Object.keys(policy.sampleProps ?? {}), path + '.sampleProps');
  if (Object.hasOwn(policy, 'slots')) {
    const slots = shape(policy.slots, [], Object.keys(policy.slots ?? {}), path + '.slots');
    for (const [name, slot] of Object.entries(slots)) validateSlotPolicy(slot, name, path);
  }
  if (Object.hasOwn(policy, 'controlledInputs'))
    validateControlledInputsPolicy(policy.controlledInputs, path);
}
function validateSlotPolicy(slot: unknown, name: string, path: string) {
  const s = shape(slot, ['prop', 'minimum', 'maximum', 'accepts'], [], path + '.slots.' + name);
  text(s.prop, path + '.slots.prop', 128);
  if (
    !Number.isSafeInteger(s.minimum) ||
    !Number.isSafeInteger(s.maximum) ||
    Number(s.minimum) < 0 ||
    Number(s.maximum) < Number(s.minimum) ||
    Number(s.maximum) > reactUiLimits.nodes ||
    !Array.isArray(s.accepts) ||
    !s.accepts.length ||
    s.accepts.length > reactUiLimits.components
  )
    throw Error('Invalid Host slot policy: ' + path);
  for (const accepted of s.accepts) {
    const ref = shape(accepted, ['registryId', 'componentId'], [], path + '.slots.accepts');
    validateReactComponentRef(
      {
        ...ref,
        version: '1.0.0',
        contractHash: '0'.repeat(64),
        implementationHash: '0'.repeat(64),
      },
      path + '.slots.accepts',
    );
  }
}
function validateControlledInputsPolicy(raw: unknown, path: string) {
  if (!Array.isArray(raw) || raw.length > reactUiLimits.fields)
    throw Error('Invalid Host controlledInputs policy: ' + path);
  for (const value of raw) {
    const pair = shape(
      value,
      ['valueProp', 'eventProp', 'argumentIndex'],
      [],
      path + '.controlledInputs',
    );
    text(pair.valueProp, path + '.controlledInputs.valueProp', 128);
    text(pair.eventProp, path + '.controlledInputs.eventProp', 128);
    if (
      !Number.isSafeInteger(pair.argumentIndex) ||
      Number(pair.argumentIndex) < 0 ||
      Number(pair.argumentIndex) > 7
    )
      throw Error('Invalid Host callback index: ' + path);
  }
}
/** Generic preview placeholders only: never published defaults or implicit prop values. */
function previewSample(schema: ReactValueSchema): JsonValue {
  switch (schema.type) {
    case 'string':
    case 'asset':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return schema.values[0];
    case 'array':
      return [];
    case 'object':
      return Object.fromEntries(
        Object.entries(schema.fields)
          .filter(([, f]) => f.required)
          .map(([key, f]) => [key, previewSample(f.schema)]),
      );
  }
}
class Unsupported extends Error {
  constructor(
    readonly code: string,
    readonly prop: string,
    reason: string,
  ) {
    super(reason);
  }
}

const componentAddress = '$component';
const infrastructureProps = ['key', 'ref', 'className', 'style'];
const isOptional = (symbol: ts.Symbol) => !!(symbol.flags & ts.SymbolFlags.Optional);

/** Whole-request preconditions checked before any entry is inspected. */
function checkExtractionRequest(program: ts.Program, request: ReactExtractionRequest) {
  validateReactExtractionRequest(request);
  const compiler = program.getCompilerOptions();
  if (!(compiler.strictNullChecks ?? compiler.strict))
    throw Error('Type extraction requires strictNullChecks for sound nullable/optional contracts');
  if (
    !request.sourceRevision ||
    request.sourceRevision.length > 512 ||
    ['main', 'head', 'latest', 'next', '*'].includes(request.sourceRevision.toLowerCase()) ||
    !request.entries.length ||
    request.entries.length > reactUiLimits.components
  )
    throw Error('Declare a bounded exact source revision and entrypoint list');
}
function checkExtractionPolicies(request: ReactExtractionRequest) {
  const supported = new Set(['exclude', 'sampleProps', 'layout', 'slots', 'controlledInputs']);
  for (const policy of Object.values(request.policies ?? {}))
    if (
      Object.keys(policy).some((k) => !supported.has(k)) ||
      (policy.exclude !== undefined && typeof policy.exclude !== 'boolean')
    )
      throw Error('Invalid Host extraction policy');
  for (const key of Object.keys(request.policies ?? {}))
    if (!request.entries.some((e) => reactExtractionPolicyKey(e.ref) === key))
      throw Error('Host policy addresses an unknown component');
}

/** Host/build-time only: inspects declarations, never imports or executes component modules. */
export function extractReactRegistrationCandidates(
  program: ts.Program,
  request: ReactExtractionRequest,
) {
  checkExtractionRequest(program, request);
  const checker = program.getTypeChecker();
  const candidates: ReactRegistrationCandidate[] = [],
    diagnostics: ReactUiDiagnostic[] = [],
    excluded: string[] = [];
  const identities = new Set<string>();
  const allowed = request.entries
    .filter((e) => !request.policies?.[reactExtractionPolicyKey(e.ref)]?.exclude)
    .map((e) => ({ registryId: e.ref.registryId, componentId: e.ref.componentId }));
  checkExtractionPolicies(request);
  const run: ExtractionRun = { program, request, checker, allowed };

  for (const entry of request.entries) {
    const key = reactExtractionPolicyKey(entry.ref),
      policy = request.policies?.[key] ?? {};
    if (identities.has(key)) throw Error('Select one export per exact component identity');
    identities.add(key);
    if (policy.exclude) {
      excluded.push(key);
      continue;
    }
    const located = { addressed: componentAddress };
    try {
      candidates.push(extractCandidate(run, entry, policy, located));
    } catch (error) {
      diagnostics.push(extractionDiagnostic(error, located.addressed, key, entry));
    }
  }
  return deepFreeze({ sourceRevision: request.sourceRevision, candidates, diagnostics, excluded });
}

interface ExtractionRun {
  program: ts.Program;
  request: ReactExtractionRequest;
  checker: ts.TypeChecker;
  allowed: ReactSlotSchema['accepts'];
}
/** The last addressed prop names a diagnostic for a failure that is not an Unsupported. */
interface ExtractionLocation {
  addressed: string;
}

function extractionDiagnostic(
  error: unknown,
  addressed: string,
  key: string,
  entry: ReactExtractionEntry,
): ReactUiDiagnostic {
  const problem =
    error instanceof Unsupported
      ? error
      : new Unsupported('registration-invalid', addressed, String(error));
  return {
    code: problem.code,
    severity: 'error',
    path: key + '.props.' + problem.prop,
    message: entry.exportName + '.' + problem.prop + ': ' + problem.message,
    recovery:
      'Correct the addressed type or supply an explicitly reviewed Host wrapper/policy, then regenerate; keep the previous registered version.',
  };
}

function extractCandidate(
  run: ExtractionRun,
  entry: ReactExtractionEntry,
  policy: ReactExtractionPolicy,
  located: ExtractionLocation,
): ReactRegistrationCandidate {
  const { checker } = run;
  const { declaration, signature, propsType } = resolveComponentSignature(run, entry);
  const { reactExports, renderable } = resolveReactRendering(checker, signature);
  const fields = propsType ? checker.getPropertiesOfType(propsType) : [];
  if (fields.length > reactUiLimits.fields)
    throw new Unsupported('schema-limit', componentAddress, 'Too many public fields');
  const scope: ComponentScope = { checker, declaration, renderable };
  const { props, events, slots } = extractFields(scope, fields, run.allowed, located);
  applySlotPolicy(policy, slots);
  const sampleProps = previewSampleProps(policy, props);
  const layout =
    policy.layout ?? (fields.some((f) => f.getName() === 'className') ? 'className' : 'none');
  checkInfrastructureProps(fields, layout);
  checkLayoutPolicy(scope, fields, layout, reactExports);
  const proposed = sealReactComponent({
    schemaVersion: 1,
    ref: entry.ref,
    name: entry.name ?? entry.exportName,
    import: entry.import,
    props,
    events,
    slots,
    layout,
    controlledInputs: policy.controlledInputs ?? [],
    requires: entry.requires ?? [],
    sampleProps,
  });
  return {
    kind: 'react-registration-candidate',
    sourceRevision: run.request.sourceRevision,
    review: 'unreviewed',
    proposed,
  };
}

/** Resolves the declared export through aliases to a type-checked source symbol. */
function resolveExportedSymbol(run: ExtractionRun, entry: ReactExtractionEntry) {
  const { program, checker } = run;
  const file = program.getSourceFile(entry.file);
  if (!file)
    throw new Unsupported(
      'source-missing',
      componentAddress,
      'Declared source file is not in the Host Program',
    );
  const errors = [
    ...program.getSyntacticDiagnostics(file),
    ...program.getSemanticDiagnostics(file),
  ].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length)
    throw new Unsupported(
      'source-typecheck',
      componentAddress,
      ts.flattenDiagnosticMessageText(errors[0].messageText, '\n'),
    );
  const module = checker.getSymbolAtLocation(file);
  const exported =
    module && checker.getExportsOfModule(module).find((s) => s.getName() === entry.exportName);
  const symbol =
    exported?.flags && exported.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exported)
      : exported;
  if (!symbol)
    throw new Unsupported(
      'export-missing',
      componentAddress,
      'Declared component export was not found',
    );
  return symbol;
}

function resolveComponentSignature(run: ExtractionRun, entry: ReactExtractionEntry) {
  const { checker } = run;
  const symbol = resolveExportedSymbol(run, entry);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration)
    throw new Unsupported('export-missing', componentAddress, 'Export has no declaration');
  const signatures = checker.getTypeOfSymbolAtLocation(symbol, declaration).getCallSignatures();
  if (signatures.length !== 1 || signatures[0].typeParameters?.length)
    throw new Unsupported(
      'component-signature',
      componentAddress,
      'Select a non-generic component with one call signature',
    );
  const parameter = signatures[0].parameters[0];
  const propsType =
    parameter &&
    checker.getTypeOfSymbolAtLocation(parameter, parameter.valueDeclaration ?? declaration);
  if (
    propsType &&
    (!(propsType.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) ||
      checker.getIndexInfosOfType(propsType).length)
  )
    throw new Unsupported(
      'component-props',
      componentAddress,
      'Declare concrete, non-indexed component props; any/unknown/union props are unsupported',
    );
  return { declaration, signature: signatures[0], propsType };
}

/** Checks the component return type and recognizes React-renderable slot types. */
function resolveReactRendering(checker: ts.TypeChecker, signature: ts.Signature) {
  // Resolve the Program's React namespace, not a same-named local namespace.
  const reactAlias = checker.resolveName('React', undefined, ts.SymbolFlags.Namespace, false);
  const react =
    reactAlias && reactAlias.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(reactAlias)
      : reactAlias;
  const reactNode =
    react && checker.getExportsOfModule(react).find((s) => s.getName() === 'ReactNode');
  const returns = checker.getReturnTypeOfSignature(signature);
  if (
    !reactNode ||
    returns.flags &
      (ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
    !checker.isTypeAssignableTo(returns, checker.getDeclaredTypeOfSymbol(reactNode))
  )
    throw new Unsupported(
      'component-return',
      componentAddress,
      'Declare a concrete React-renderable return type',
    );
  // Compare declaration symbols from this Program's React module, never local names.
  const reactExports = react ? checker.getExportsOfModule(react) : [];
  const reactSymbols = new Set(
    reactExports.filter((s) =>
      ['ReactNode', 'ReactElement', 'ReactPortal', 'ReactChild'].includes(s.getName()),
    ),
  );
  const renderable = (type: ts.Type): boolean =>
    (!!type.aliasSymbol && reactSymbols.has(type.aliasSymbol)) ||
    (!!type.getSymbol() && reactSymbols.has(type.getSymbol()!)) ||
    (type.isUnion() && type.types.some(renderable));
  return { reactExports, renderable };
}

interface ComponentScope {
  checker: ts.TypeChecker;
  declaration: ts.Declaration;
  renderable: (type: ts.Type) => boolean;
}
const typeOfSymbol = (scope: ComponentScope, symbol: ts.Symbol) =>
  scope.checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? scope.declaration);

function readSchema(
  scope: ComponentScope,
  type: ts.Type,
  path: string,
  depth = 0,
  optional = false,
): ReactValueSchema {
  if (depth > reactUiLimits.schemaDepth)
    throw new Unsupported('schema-depth', path, 'Type nesting exceeds the supported depth');
  if (scope.renderable(type))
    throw new Unsupported(
      'nested-react-node',
      path,
      'ReactNode inside JSON data is unsupported; expose a top-level slot in a Host wrapper',
    );
  if (!optional && members(type).some((t) => t.flags & ts.TypeFlags.Undefined))
    throw new Unsupported(
      'unsupported-union',
      path,
      'Required JSON fields cannot include undefined; normalize the type or declare the field optional in a Host adapter',
    );
  const types = concrete(type),
    nullable = members(type).some((t) => t.flags & ts.TypeFlags.Null);
  const result = literalSchema(types, path) ?? singleSchema(scope, types[0], path, depth);
  return nullable ? { ...result, nullable: true } : result;
}

/** Enum and boolean unions; undefined when exactly one other concrete type remains. */
function literalSchema(types: ts.Type[], path: string): ReactValueSchema | undefined {
  if (!types.length)
    throw new Unsupported('unsupported-type', path, 'A concrete JSON value type is required');
  if (types.some((t) => t.flags & ts.TypeFlags.NumberLiteral))
    throw new Unsupported(
      'unsupported-numeric-literal',
      path,
      'Numeric literal constraints require an explicit Host wrapper; they cannot be widened to number',
    );
  if (types.every((t) => t.flags & ts.TypeFlags.StringLiteral))
    return {
      type: 'enum',
      values: [...new Set(types.map((t) => (t as ts.StringLiteralType).value))].sort(),
    };
  if (types.every((t) => t.flags & ts.TypeFlags.BooleanLike)) return { type: 'boolean' };
  if (types.length !== 1)
    throw new Unsupported(
      'unsupported-union',
      path,
      'Only string-literal enums and nullable JSON types are supported; normalize the union in a Host adapter',
    );
  return undefined;
}

function singleSchema(
  scope: ComponentScope,
  t: ts.Type,
  path: string,
  depth: number,
): ReactValueSchema {
  const { checker } = scope;
  if (t.flags & ts.TypeFlags.StringLike) return { type: 'string' };
  if (t.flags & ts.TypeFlags.NumberLike) return { type: 'number' };
  if (checker.isArrayType(t)) {
    const item = checker.getTypeArguments(t as ts.TypeReference)[0];
    return {
      type: 'array',
      items: readSchema(scope, item, path + '[]', depth + 1),
      maxItems: 1000,
    };
  }
  if (
    t.flags & ts.TypeFlags.Object &&
    !checker.isTupleType(t) &&
    !t.getCallSignatures().length &&
    !checker.getIndexInfosOfType(t).length
  )
    return objectSchema(scope, t, path, depth);
  throw new Unsupported(
    'unsupported-type',
    path,
    'Type is outside the JSON/slot/normalized callback subset: ' + checker.typeToString(t),
  );
}

function objectSchema(
  scope: ComponentScope,
  t: ts.Type,
  path: string,
  depth: number,
): ReactValueSchema {
  const fs = scope.checker.getPropertiesOfType(t);
  if (!fs.length || fs.length > reactUiLimits.fields)
    throw new Unsupported(
      'unsupported-object',
      path,
      'Declare bounded object fields instead of an opaque/indexed object',
    );
  const fields: Record<string, ReactFieldSchema> = {};
  for (const f of fs.sort((a, b) => compare(a.getName(), b.getName()))) {
    const ft = typeOfSymbol(scope, f);
    fields[f.getName()] = {
      required: !(f.flags & ts.SymbolFlags.Optional),
      schema: readSchema(scope, ft, path + '.' + f.getName(), depth + 1, isOptional(f)),
    };
  }
  return { type: 'object', fields };
}

/** Sorts fields in place, then classifies each as a slot, event or JSON prop. */
function extractFields(
  scope: ComponentScope,
  fields: ts.Symbol[],
  allowed: ReactSlotSchema['accepts'],
  located: ExtractionLocation,
) {
  const props: RegisteredReactComponent['props'] = {},
    events: RegisteredReactComponent['events'] = {},
    slots: RegisteredReactComponent['slots'] = {};
  for (const field of fields.sort((a, b) => compare(a.getName(), b.getName()))) {
    const name = (located.addressed = field.getName());
    if (infrastructureProps.includes(name)) continue;
    const type = typeOfSymbol(scope, field);
    if (scope.renderable(type)) {
      slots[name] = {
        prop: name,
        minimum: field.flags & ts.SymbolFlags.Optional ? 0 : 1,
        maximum: reactUiLimits.nodes,
        accepts: allowed,
      };
      continue;
    }
    const types = concrete(type),
      calls = types.length === 1 ? types[0].getCallSignatures() : [];
    if (calls.length) events[name] = extractEvent(scope, field, name, calls);
    else
      props[name] = {
        required: !(field.flags & ts.SymbolFlags.Optional),
        schema: readSchema(scope, type, name, 0, isOptional(field)),
      };
  }
  return { props, events, slots };
}

function unsupportedCallbackParameter(scope: ComponentScope, p: ts.Symbol) {
  return (
    p.flags & ts.SymbolFlags.Optional ||
    members(typeOfSymbol(scope, p)).some((t) => t.flags & ts.TypeFlags.Undefined) ||
    (p.valueDeclaration &&
      ts.isParameter(p.valueDeclaration) &&
      (p.valueDeclaration.dotDotDotToken ||
        p.valueDeclaration.questionToken ||
        p.valueDeclaration.initializer))
  );
}

function extractEvent(
  scope: ComponentScope,
  field: ts.Symbol,
  name: string,
  calls: readonly ts.Signature[],
): RegisteredReactComponent['events'][string] {
  if (!(field.flags & ts.SymbolFlags.Optional))
    throw new Unsupported(
      'required-callback',
      name,
      'The event contract cannot preserve a required callback; use an explicit Host wrapper with an optional normalized callback',
    );
  if (
    calls.length !== 1 ||
    calls[0].typeParameters?.length ||
    !(scope.checker.getReturnTypeOfSignature(calls[0]).flags & ts.TypeFlags.Void)
  )
    throw new Unsupported(
      'callback-signature',
      name,
      'Declare one non-generic void callback with normalized JSON arguments',
    );
  const parameters = calls[0].parameters;
  if (parameters.length > 8 || parameters.some((p) => unsupportedCallbackParameter(scope, p)))
    throw new Unsupported(
      'callback-arguments',
      name,
      'Optional/rest or more than eight callback arguments are unsupported; normalize in a Host adapter',
    );
  return {
    returns: 'void',
    parameters: parameters.map((p) =>
      readSchema(scope, typeOfSymbol(scope, p), name + '.' + p.getName()),
    ),
  };
}

function applySlotPolicy(policy: ReactExtractionPolicy, slots: RegisteredReactComponent['slots']) {
  for (const [slot, value] of Object.entries(policy.slots ?? {})) {
    if (!Object.hasOwn(slots, slot) || value.prop !== slots[slot].prop)
      throw new Unsupported(
        'host-slot-policy',
        slot,
        'Host slot policy must address an extracted top-level ReactNode prop',
      );
    if (value.minimum < slots[slot].minimum)
      throw new Unsupported(
        'host-slot-policy',
        slot,
        'Host policy cannot lower the extracted required slot minimum; use an explicit optional-prop wrapper',
      );
    slots[slot] = value;
  }
}

function previewSampleProps(
  policy: ReactExtractionPolicy,
  props: RegisteredReactComponent['props'],
) {
  for (const [prop, value] of Object.entries(policy.sampleProps ?? {}))
    if (!Object.hasOwn(props, prop) || !valueMatches(props[prop].schema, value))
      throw new Unsupported(
        'host-sample-policy',
        prop,
        'Host sample value does not match an extracted JSON prop',
      );
  const sampleProps = Object.fromEntries(
    Object.entries(props)
      .filter(([, f]) => f.required)
      .map(([prop, f]) => [prop, previewSample(f.schema)]),
  );
  Object.assign(sampleProps, policy.sampleProps ?? {});
  return sampleProps;
}

type ReactLayout = RegisteredReactComponent['layout'];

function checkInfrastructureProps(fields: ts.Symbol[], layout: ReactLayout) {
  for (const field of fields) {
    const name = field.getName();
    if (
      !(field.flags & ts.SymbolFlags.Optional) &&
      ['className', 'style', 'key', 'ref'].includes(name) &&
      layout !== name
    )
      throw new Unsupported(
        'required-infrastructure-prop',
        name,
        'Required React/layout props cannot be omitted; normalize them in an explicit Host wrapper',
      );
  }
}

function checkLayoutPolicy(
  scope: ComponentScope,
  fields: ts.Symbol[],
  layout: ReactLayout,
  reactExports: ts.Symbol[],
) {
  const className = fields.find((f) => f.getName() === 'className');
  if (
    layout === 'className' &&
    (!className ||
      !concrete(typeOfSymbol(scope, className)).some((t) => t.flags & ts.TypeFlags.String))
  )
    throw new Unsupported(
      'host-layout-policy',
      'className',
      'Generated className requires an unrestricted string prop; choose an explicit Host wrapper',
    );
  if (layout === 'style') checkStyleLayout(scope, fields, reactExports);
}

function checkStyleLayout(scope: ComponentScope, fields: ts.Symbol[], reactExports: ts.Symbol[]) {
  const { checker } = scope;
  const style = fields.find((f) => f.getName() === 'style');
  const cssSymbol = reactExports.find((s) => s.getName() === 'CSSProperties');
  const css = cssSymbol && checker.getDeclaredTypeOfSymbol(cssSymbol);
  const styleType = style && typeOfSymbol(scope, style);
  if (
    !css ||
    !styleType ||
    !concrete(styleType).some(
      (t) =>
        !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
        checker.isTypeAssignableTo(css, t) &&
        checker.getPropertiesOfType(css).every((p) => !!checker.getPropertyOfType(t, p.getName())),
    )
  )
    throw new Unsupported(
      'host-layout-policy',
      'style',
      'Generated style requires a React.CSSProperties-compatible prop; choose an explicit Host wrapper',
    );
}
