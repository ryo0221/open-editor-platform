import type { IncomingMessage } from 'node:http';
import { fail } from '@editor-platform/collaboration-core';
import type { CharacterDocument } from '@editor-platform/character-core';
import type { VideoContentV3 } from '@editor-platform/video-core';

/** An authenticated Host project, including the right to see its timeline and retained snapshots. */
export interface HostedProjectAccess {
  viewerId: string;
  generation: string;
  writable: boolean;
}
export interface HostedProjects {
  access(request: IncomingMessage, artifactId: string): Promise<HostedProjectAccess | undefined>;
  /** Load the fixed native project from trusted storage. Never accept a seed from the join request. */
  load(
    artifactId: string,
    generation: string,
  ): Promise<{ name: string; content: VideoContentV3 | CharacterDocument }>;
}
export function hostedDomain(id: string) {
  if (id.startsWith('host-video-')) return 'video';
  if (id.startsWith('host-character-')) return 'character';
}
export async function currentProjectAccess(
  host: HostedProjects | undefined,
  req: IncomingMessage,
  id: string,
  prior?: Pick<HostedProjectAccess, 'generation' | 'viewerId'>,
) {
  const grant = await host?.access(req, id);
  if (
    !grant?.viewerId ||
    !grant.generation ||
    (prior && (prior.generation !== grant.generation || prior.viewerId !== grant.viewerId))
  )
    fail('unauthorized', 'Shared project access is unavailable');
  return grant;
}
