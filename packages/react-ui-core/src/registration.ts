import { clone, deepFreeze } from '@editor-platform/artifact-core';
import {
  reuseHash,
  tokenId,
  validateReusableDefinitionSync,
  resolveTokens,
} from '@editor-platform/reuse-core';
import {
  array,
  checkData,
  fields,
  finite,
  hash,
  id,
  identifier,
  object,
  ReactUiError,
  reject,
  unique,
  version,
} from './data';
import { checkFieldMap, checkValueSchema, sameSchema, valueMatches } from './schema';
import {
  reactUiLimits,
  type ReactComponentRef,
  type ReactEnvironmentRef,
  type ReactEnvironment,
  type ReactImport,
  type RegisteredReactComponent,
  type ReactCallbackSchema,
} from './types';

export const reactComponentKey = (
  ref: Pick<ReactComponentRef, 'registryId' | 'componentId' | 'version'>,
): string => JSON.stringify([ref.registryId, ref.componentId, ref.version]);
export function checkComponentRef(raw: unknown, path: string): asserts raw is ReactComponentRef {
  const r = object(raw, path);
  fields(
    r,
    ['registryId', 'componentId', 'version', 'contractHash', 'implementationHash'],
    [],
    path,
  );
  id(r.registryId, path);
  id(r.componentId, path);
  version(r.version, path);
  hash(r.contractHash, path);
  hash(r.implementationHash, path);
}
export function checkEnvironmentRef(
  raw: unknown,
  path: string,
): asserts raw is ReactEnvironmentRef {
  const r = object(raw, path);
  fields(r, ['id', 'version', 'hash'], [], path);
  id(r.id, path);
  version(r.version, path);
  hash(r.hash, path);
}
export function checkImport(raw: unknown, path: string): asserts raw is ReactImport {
  const imp = object(raw, path);
  fields(imp, ['source', 'export'], ['name'], path);
  if (
    typeof imp.source !== 'string' ||
    imp.source.length > 240 ||
    !/^(?:@?[A-Za-z0-9_][A-Za-z0-9_./@-]*|\.\/[A-Za-z0-9_][A-Za-z0-9_./-]*)$/.test(imp.source) ||
    imp.source.split('/').some((p) => !p || p === '..') ||
    !['named', 'default'].includes(String(imp.export))
  )
    reject('import', path, 'Expected a Host-approved package/alias/relative import path');
  if (imp.export === 'named') {
    identifier(imp.name, `${path}.name`);
    if (!/^[A-Z]/.test(imp.name))
      reject('import', path, 'React component/Provider export must start with an uppercase letter');
  } else if (imp.name !== undefined)
    reject('import', path, 'Default exports do not declare a named export');
}
export function checkCallbacks(
  raw: unknown,
  path: string,
): asserts raw is Record<string, ReactCallbackSchema> {
  const map = object(raw, path);
  if (Object.keys(map).length > reactUiLimits.fields)
    reject('schema-limit', path, 'Too many callbacks');
  for (const [key, value] of Object.entries(map)) {
    identifier(key, `${path}.${key}`);
    const callback = object(value, `${path}.${key}`);
    fields(callback, ['parameters', 'returns'], [], `${path}.${key}`);
    if (callback.returns !== 'void')
      reject('callback', `${path}.${key}`, 'Only void callbacks are supported');
    array(callback.parameters, `${path}.${key}.parameters`, 8).forEach((p, i) =>
      checkValueSchema(p, `${path}.${key}.parameters.${i}`),
    );
  }
}
const componentDigest = (value: RegisteredReactComponent): string => {
  const { contractHash: _hash, ...ref } = value.ref;
  return reuseHash({ ...value, ref });
};
function checkComponent(raw: unknown): asserts raw is RegisteredReactComponent {
  const c = object(raw, '$.component');
  fields(
    c,
    [
      'schemaVersion',
      'ref',
      'name',
      'import',
      'props',
      'events',
      'slots',
      'controlledInputs',
      'layout',
      'requires',
      'sampleProps',
    ],
    [],
    '$.component',
  );
  if (
    c.schemaVersion !== 1 ||
    typeof c.name !== 'string' ||
    !c.name.trim() ||
    c.name.length > 160 ||
    !['none', 'className', 'style', 'wrapper'].includes(String(c.layout))
  )
    reject('registration', '$.component', 'Unsupported component registration');
  checkComponentRef(c.ref, '$.component.ref');
  checkImport(c.import, '$.component.import');
  checkFieldMap(c.props, '$.component.props');
  checkCallbacks(c.events, '$.component.events');
  const slots = object(c.slots, '$.component.slots');
  if (Object.keys(slots).length > reactUiLimits.fields)
    reject('schema-limit', '$.component.slots', 'Too many slots');
  const publicNames = [...Object.keys(c.props), ...Object.keys(c.events)];
  for (const [key, value] of Object.entries(slots)) {
    id(key, `$.component.slots.${key}`);
    const slot = object(value, `$.component.slots.${key}`);
    fields(slot, ['prop', 'minimum', 'maximum', 'accepts'], [], `$.component.slots.${key}`);
    identifier(slot.prop, `$.component.slots.${key}.prop`);
    publicNames.push(slot.prop);
    finite(slot.minimum, `$.component.slots.${key}`, 0, reactUiLimits.nodes, true);
    finite(slot.maximum, `$.component.slots.${key}`, slot.minimum, reactUiLimits.nodes, true);
    const accepts = array(
      slot.accepts,
      `$.component.slots.${key}.accepts`,
      reactUiLimits.components,
    );
    if (!accepts.length)
      reject(
        'slot-contract',
        `$.component.slots.${key}`,
        'Declare explicitly which components may be inserted',
      );
    accepts.forEach((value) => {
      const a = object(value, `$.component.slots.${key}`);
      fields(a, ['registryId', 'componentId'], [], `$.component.slots.${key}`);
      id(a.registryId, `$.component.slots.${key}`);
      id(a.componentId, `$.component.slots.${key}`);
    });
    unique(
      accepts.map((a) => reuseHash(a)),
      `$.component.slots.${key}`,
    );
  }
  unique(publicNames, '$.component');
  if (
    publicNames.some((name) =>
      ['key', 'ref', 'className', 'style', 'dangerouslySetInnerHTML'].includes(name),
    ) ||
    Object.keys(c.props).some((name) => name === 'children' || /^on[A-Z]/.test(name))
  )
    reject(
      'prop-contract',
      '$.component',
      'React/layout props are reserved; events and children use dedicated contracts',
    );
  const pairs = array(c.controlledInputs, '$.component.controlledInputs', reactUiLimits.fields);
  for (const [index, value] of pairs.entries()) {
    const pair = object(value, `$.component.controlledInputs.${index}`);
    fields(
      pair,
      ['valueProp', 'eventProp', 'argumentIndex'],
      [],
      `$.component.controlledInputs.${index}`,
    );
    identifier(pair.valueProp, '$.component.controlledInputs');
    identifier(pair.eventProp, '$.component.controlledInputs');
    finite(pair.argumentIndex, '$.component.controlledInputs', 0, 7, true);
    const prop = c.props[pair.valueProp],
      event = c.events[pair.eventProp];
    if (
      !prop ||
      !event ||
      !event.parameters[pair.argumentIndex] ||
      !sameSchema(prop.schema, event.parameters[pair.argumentIndex])
    )
      reject(
        'controlled-contract',
        `$.component.controlledInputs.${index}`,
        'Value prop and normalized callback argument must have the same schema',
      );
  }
  unique(
    pairs.map((p) => (p as { valueProp: string }).valueProp),
    '$.component.controlledInputs',
  );
  unique(
    pairs.map((p) => (p as { eventProp: string }).eventProp),
    '$.component.controlledInputs',
  );
  array(c.requires, '$.component.requires', reactUiLimits.dependencies).forEach((value) =>
    id(value, '$.component.requires'),
  );
  unique(c.requires as string[], '$.component.requires');
  const sample = object(c.sampleProps, '$.component.sampleProps');
  for (const [key, value] of Object.entries(sample)) {
    if (!Object.hasOwn(c.props, key) || !valueMatches(c.props[key].schema, value))
      reject(
        'sample-prop',
        `$.component.sampleProps.${key}`,
        'Unknown or invalid preview sample prop',
      );
  }
  for (const [key, field] of Object.entries(c.props))
    if (field.required && !Object.hasOwn(field, 'default') && !Object.hasOwn(sample, key))
      reject(
        'sample-prop',
        `$.component.sampleProps.${key}`,
        'A required prop needs a preview sample or declared default',
      );
}
export function validateReactComponent(raw: unknown): RegisteredReactComponent {
  checkData(raw);
  checkComponent(raw);
  if (raw.ref.contractHash !== componentDigest(raw))
    reject(
      'registration-hash',
      '$.component.ref.contractHash',
      'Registration hash disagrees with its immutable content',
    );
  return deepFreeze(clone(raw));
}
export function sealReactComponent(
  raw: Omit<RegisteredReactComponent, 'ref'> & { ref: Omit<ReactComponentRef, 'contractHash'> },
): RegisteredReactComponent {
  checkData(raw);
  object(raw, '$.component');
  object(raw.ref, '$.component.ref');
  // Reject an unexpected hash even from untyped callers; never silently re-seal a published ref.
  if (Object.hasOwn(raw.ref, 'contractHash'))
    reject('registration-hash', '$.component.ref', 'Sealing expects an unpublished contract');
  const candidate: RegisteredReactComponent = {
    ...clone(raw),
    ref: { ...clone(raw.ref), contractHash: '0'.repeat(64) },
  };
  checkComponent(candidate);
  candidate.ref.contractHash = componentDigest(candidate);
  return deepFreeze(candidate);
}
const environmentDigest = (value: ReactEnvironment): string => {
  const { hash: _hash, ...ref } = value.ref;
  return reuseHash({ ...value, ref });
};
function checkEnvironment(raw: unknown): asserts raw is ReactEnvironment {
  const e = object(raw, '$.environment');
  fields(
    e,
    [
      'schemaVersion',
      'ref',
      'reactVersion',
      'dependencies',
      'providerOrder',
      'stylePolicy',
      'tokenVariables',
    ],
    ['tokens', 'tokenMode'],
    '$.environment',
  );
  if (e.schemaVersion !== 1 || !['allow-literals', 'tokens-only'].includes(String(e.stylePolicy)))
    reject('environment', '$.environment', 'Unsupported environment/style policy');
  checkEnvironmentRef(e.ref, '$.environment.ref');
  version(e.reactVersion, '$.environment.reactVersion', true);
  const dependencies = array(
    e.dependencies,
    '$.environment.dependencies',
    reactUiLimits.dependencies,
  );
  for (const [index, raw] of dependencies.entries()) {
    const path = `$.environment.dependencies.${index}`,
      d = object(raw, path);
    id(d.id, path);
    hash(d.hash, path);
    switch (d.kind) {
      case 'package':
        fields(d, ['id', 'hash', 'kind', 'name', 'version'], [], path);
        if (
          typeof d.name !== 'string' ||
          !/^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9_.-]{0,100}$/.test(d.name)
        )
          reject('dependency', path, 'Invalid package name');
        version(d.version, path, true);
        break;
      case 'css':
      case 'asset':
        fields(d, ['id', 'hash', 'kind', 'path'], d.kind === 'asset' ? ['mediaType'] : [], path);
        if (
          typeof d.path !== 'string' ||
          d.path.length > 240 ||
          !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(d.path) ||
          d.path.split('/').some((part) => !part || part === '.' || part === '..')
        )
          reject('dependency-path', path, 'Expected a safe relative dependency path');
        if (
          d.kind === 'asset' &&
          !['image/png', 'image/jpeg', 'image/webp'].includes(String(d.mediaType))
        )
          reject('dependency', path, 'Unsupported image media type');
        break;
      case 'provider':
        fields(d, ['id', 'hash', 'kind', 'import', 'props'], [], path);
        checkImport(d.import, `${path}.import`);
        {
          const props = object(d.props, `${path}.props`);
          if (
            Object.keys(props).some((k) =>
              ['children', 'key', 'ref', 'dangerouslySetInnerHTML'].includes(k),
            )
          )
            reject('provider', path, 'Provider children/runtime props are Host-owned');
        }
        break;
      default:
        reject('dependency', path, 'Unsupported runtime dependency');
    }
  }
  unique(
    dependencies.map((d) => (d as { id: string }).id),
    '$.environment.dependencies',
  );
  unique(
    dependencies
      .filter((d) => ['css', 'asset'].includes((d as { kind: string }).kind))
      .map((d) => (d as { path: string }).path.toLowerCase()),
    '$.environment.dependencies',
  );
  unique(
    dependencies
      .filter((d) => (d as { kind: string }).kind === 'package')
      .map((d) => (d as { name: string }).name),
    '$.environment.dependencies',
  );
  const providers = array(
    e.providerOrder,
    '$.environment.providerOrder',
    reactUiLimits.dependencies,
  );
  providers.forEach((value) => id(value, '$.environment.providerOrder'));
  unique(providers, '$.environment.providerOrder');
  const declared = dependencies
    .filter((d) => (d as { kind: string }).kind === 'provider')
    .map((d) => (d as { id: string }).id);
  if (declared.length !== providers.length || providers.some((p) => !declared.includes(String(p))))
    reject(
      'provider',
      '$.environment.providerOrder',
      'Every Provider needs one explicit ordered position',
    );
  const vars = object(e.tokenVariables, '$.environment.tokenVariables');
  if (Object.keys(vars).length > 2048)
    reject('schema-limit', '$.environment.tokenVariables', 'Too many token variables');
  for (const [key, value] of Object.entries(vars))
    if (
      !tokenId(key) ||
      typeof value !== 'string' ||
      !/^--[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(value)
    )
      reject(
        'token-variable',
        `$.environment.tokenVariables.${key}`,
        'Invalid token/CSS variable mapping',
      );
  unique(Object.values(vars), '$.environment.tokenVariables');
  if (e.tokens !== undefined) {
    try {
      const tokens = validateReusableDefinitionSync(e.tokens);
      if (tokens.kind !== 'tokens' || tokens.domain !== 'shared' || tokens.dependencies.length)
        reject(
          'tokens',
          '$.environment.tokens',
          'Expected a self-contained shared token definition',
        );
      id(e.tokenMode, '$.environment.tokenMode');
      const resolved = resolveTokens(tokens.payload, { artifactMode: e.tokenMode });
      if (Object.keys(vars).some((key) => !Object.hasOwn(resolved.tokens, key)))
        reject(
          'token-variable',
          '$.environment.tokenVariables',
          'CSS variable maps an unknown token',
        );
    } catch (error) {
      if (error instanceof ReactUiError) throw error;
      reject(
        'tokens',
        '$.environment.tokens',
        error instanceof Error ? error.message : 'Invalid retained token definition',
      );
    }
  } else if (e.tokenMode !== undefined || Object.keys(vars).length)
    reject(
      'tokens',
      '$.environment',
      'Token mappings require a retained token definition and mode',
    );
}
export function validateReactEnvironment(raw: unknown): ReactEnvironment {
  checkData(raw);
  checkEnvironment(raw);
  if (raw.ref.hash !== environmentDigest(raw))
    reject(
      'environment-hash',
      '$.environment.ref.hash',
      'Environment hash disagrees with its immutable content',
    );
  return deepFreeze(clone(raw));
}
export function sealReactEnvironment(
  raw: Omit<ReactEnvironment, 'ref'> & { ref: Omit<ReactEnvironmentRef, 'hash'> },
): ReactEnvironment {
  checkData(raw);
  object(raw, '$.environment');
  object(raw.ref, '$.environment.ref');
  if (Object.hasOwn(raw.ref, 'hash'))
    reject('environment-hash', '$.environment.ref', 'Sealing expects an unpublished environment');
  const candidate: ReactEnvironment = {
    ...clone(raw),
    ref: { ...clone(raw.ref), hash: '0'.repeat(64) },
  };
  checkEnvironment(candidate);
  candidate.ref.hash = environmentDigest(candidate);
  return deepFreeze(candidate);
}
