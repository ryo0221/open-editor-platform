/** Private cross-Artifact origin reference. It never grants authority or changes version ancestry. */
export interface MigrationReference {
  converter: 'video-v1-to-v2-1';
  sourceArtifactId: string;
  sourceVersionId: string;
  sourceContentHash: string;
  sourceArchiveHash: string;
  targetArtifactId: string;
  targetVersionId: string;
  targetContentHash: string;
}
