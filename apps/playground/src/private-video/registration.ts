/** Host-private registration only. Not an Extension public API or untrusted loader. */
export const privateVideo = Object.freeze({
  id: 'video-v1-review',
  label: 'Video — private review',
  contract: 'normal-video-host@0-private',
  dependency: '3b45be9f53e7a32c881f226cd0e5a44728fc449e',
  schema: 'video-core-prototype-v1',
  capabilities: Object.freeze(['create', 'local-edit', 'save', 'portable', 'history-view']),
});
export function requirePrivateVideoCapability(capability: string) {
  if (!privateVideo.capabilities.includes(capability))
    throw new Error(`Private Video capability unavailable: ${capability}`);
}
export function privateVideoRoute(search: string) {
  const params = new URLSearchParams(search);
  if (params.has('shared') && params.get('kind') === 'video')
    throw new Error('Private Video shared capability unavailable');
  if (!params.has('privateEditor')) return undefined;
  if (params.get('privateEditor') !== privateVideo.id || params.has('shared'))
    throw new Error('Unsupported private Editor or shared context');
  const entryId = params.get('project') ?? undefined;
  if (entryId !== undefined && !/^[a-f0-9-]{36}$/.test(entryId))
    throw new Error('Invalid private project locator');
  return { entryId };
}
export function privateVideoUrl(entryId?: string) {
  return `/?${new URLSearchParams({ privateEditor: privateVideo.id, ...(entryId ? { project: entryId } : {}) })}`;
}
