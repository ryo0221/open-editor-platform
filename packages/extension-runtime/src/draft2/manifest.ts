import type {
  AddonId,
  DefinitionD2,
  Grant,
  ManifestD2,
  Pin,
  Unavailable,
} from '@editor-platform/extension-contract/draft2';
import { copyData, frozen, requireThat } from './primitives';
export const TOKEN = '1.0.0-draft.2' as const;
export const VERSIONS = {
  edit: 'local-edit@0-draft',
  inputs: 'inputs@0-draft',
  save: 'local-persistence@0-draft',
  lifecycle: 'lifecycle@0-draft',
  resources: 'resources@0-draft',
} as const;
export const ADDONS = Object.keys(VERSIONS) as AddonId[];
export const GRANTS: readonly Grant[] = [
  'artifact:read',
  'artifact:edit',
  'artifact:save',
  'resource:read',
];
export type ParsedManifest = Omit<ManifestD2, 'addons'> & {
  addons: Partial<Record<AddonId, { version: string; requirement: 'required' | 'optional' }>>;
};
function keys(value: object, allowed: readonly string[]) {
  requireThat(
    Object.keys(value).every((key) => allowed.includes(key)),
    'manifest',
  );
}
export function parseManifest(input: unknown): ParsedManifest {
  const value = copyData(input) as ParsedManifest;
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'manifest');
  keys(value, [
    'id',
    'version',
    'packageHash',
    'contractVersion',
    'artifactKind',
    'schemaVersion',
    'surface',
    'permissions',
    'addons',
    'licenseNotices',
  ]);
  requireThat(value.contractVersion === TOKEN, 'contract');
  for (const field of ['id', 'version', 'artifactKind'] as const)
    requireThat(
      typeof value[field] === 'string' && value[field].length > 0 && value[field].length <= 128,
      'manifest',
    );
  requireThat(
    typeof value.packageHash === 'string' && /^[a-f0-9]{64}$/.test(value.packageHash),
    'manifest',
  );
  requireThat(
    Number.isSafeInteger(value.schemaVersion) &&
      value.schemaVersion >= 1 &&
      typeof value.surface === 'boolean',
    'manifest',
  );
  requireThat(
    Array.isArray(value.permissions) &&
      value.permissions.every((grant) => GRANTS.includes(grant)) &&
      new Set(value.permissions).size === value.permissions.length,
    'manifest',
  );
  requireThat(
    Array.isArray(value.licenseNotices) &&
      value.licenseNotices.every((item) => typeof item === 'string'),
    'manifest',
  );
  requireThat(
    value.addons && typeof value.addons === 'object' && !Array.isArray(value.addons),
    'manifest',
  );
  keys(value.addons, ADDONS);
  for (const request of Object.values(value.addons)) {
    requireThat(request && typeof request === 'object' && !Array.isArray(request), 'manifest');
    keys(request, ['version', 'requirement']);
    requireThat(
      typeof request.version === 'string' &&
        request.version.length > 0 &&
        request.version.length <= 128 &&
        ['required', 'optional'].includes(request.requirement),
      'manifest',
    );
  }
  requireThat(!value.surface || value.addons.lifecycle?.requirement === 'required', 'manifest');
  return frozen(value);
}
export function samePin(manifest: Pin, pin: Pin): boolean {
  return (
    manifest.id === pin.id &&
    manifest.version === pin.version &&
    manifest.packageHash === pin.packageHash
  );
}
export function negotiate<T, Ref>(
  manifest: Pick<ParsedManifest, 'surface' | 'permissions' | 'addons'>,
  definition: Pick<DefinitionD2<T, Ref>, 'validate'> & { mount?: unknown },
  config: {
    supported: readonly AddonId[];
    grants: ReadonlySet<Grant>;
    recovery: boolean;
    storage: boolean;
    resources: boolean;
  },
): Record<AddonId, Unavailable | undefined> {
  requireThat(
    typeof definition.validate === 'function' &&
      (!manifest.surface || typeof definition.mount === 'function'),
    'manifest',
  );
  const reason = {} as Record<AddonId, Unavailable | undefined>;
  const permitted = (grant: Grant) =>
    manifest.permissions.includes(grant) && config.grants.has(grant);
  for (const id of ADDONS) {
    const request = manifest.addons[id];
    reason[id] = !request
      ? 'not-requested'
      : !config.supported.includes(id)
        ? 'unsupported'
        : request.version !== VERSIONS[id]
          ? 'version-mismatch'
          : undefined;
    const grant =
      id === 'edit' || id === 'inputs'
        ? 'artifact:edit'
        : id === 'save'
          ? 'artifact:save'
          : id === 'resources'
            ? 'resource:read'
            : undefined;
    if (!reason[id] && grant && !permitted(grant)) reason[id] = 'permission-denied';
  }
  if (!reason.inputs && (reason.edit || !config.recovery)) reason.inputs = 'dependency-unavailable';
  if (!reason.save && (reason.lifecycle || !config.storage)) reason.save = 'dependency-unavailable';
  if (!reason.resources && (reason.lifecycle || !config.resources))
    reason.resources = 'dependency-unavailable';
  return reason;
}
