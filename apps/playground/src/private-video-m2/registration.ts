/** Host-private validation metadata. Not an Extension public registration. */
export const privateVideoM2 = Object.freeze({
  id: 'video-v2-review',
  label: 'Video',
  contract: 'normal-video-m2-host@0-private',
  schema: 'video-core-prototype-v3',
  dependency: '87c7aef1d47aefdf37cff5591be59f4ca8df77bb',
  capabilities: Object.freeze(['create', 'local-edit', 'save', 'portable', 'history-view']),
});
export const projectIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function requirePrivateVideoM2Capability(capability: string) {
  if (!privateVideoM2.capabilities.includes(capability))
    throw new Error(`Private Video M2 capability unavailable: ${capability}`);
}
/** A future dispatcher must select this exact private id; v1 has its own unchanged parser. */
export function privateVideoM2Route(search: string) {
  const params = new URLSearchParams(search);
  if (!params.has('privateEditor')) return undefined;
  if (
    params.getAll('privateEditor').length !== 1 ||
    params.get('privateEditor') !== privateVideoM2.id ||
    params.has('shared') ||
    params.getAll('project').length > 1 ||
    params.has('nativeSchema')
  )
    throw new Error('Unsupported private M2 Editor or shared context');
  const entryId = params.get('project') ?? undefined;
  if (entryId !== undefined && !projectIdPattern.test(entryId))
    throw new Error('Invalid private M2 project locator');
  return { entryId };
}
export function privateVideoM2Url(entryId?: string) {
  if (entryId !== undefined && !projectIdPattern.test(entryId))
    throw new Error('Invalid private M2 project locator');
  return `/?${new URLSearchParams({ privateEditor: privateVideoM2.id, ...(entryId ? { project: entryId } : {}) })}`;
}
