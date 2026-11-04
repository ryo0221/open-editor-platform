import { createRoot } from 'react-dom/client';
import { clone, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import type { LocalDraftRevision } from '@editor-platform/editor-core';
import type { DesignContent } from '@editor-platform/design/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import {
  CreativeHost,
  CreativeProject,
  characterMode,
  type CreativeMapping,
} from '@editor-platform/reference-artifact-host/creative';

/** Test-only consuming Host port. No production debug hook or storage adapter is changed. */
export interface CreativeConcurrencyFixture {
  changeSourceName(value: string): Promise<void>;
  snapshot(): {
    source: StructuredData;
    artwork: DesignContent;
    sourceRevision: LocalDraftRevision;
    sourceVersionId: string | null;
    sourceVersions: number;
  };
}
declare global {
  interface Window {
    creativeConcurrency?: CreativeConcurrencyFixture;
  }
}

async function mount() {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  let mapping: CreativeMapping | undefined;
  const project = await CreativeProject.open(characterMode, {
    artifacts,
    async readMapping() {
      return clone(mapping);
    },
    async writeMapping(value) {
      mapping = clone(value);
    },
  });
  const artwork = await project.ensureDesign(project.cards[0]);
  await project.save();
  window.creativeConcurrency = {
    async changeSourceName(value) {
      // Emulate another consuming-Host action arriving after the field buffer opened.
      await Promise.resolve();
      const card = project.cards[0];
      const name = card.fields.find((field) => field.label === '名前');
      if (!name) throw Error('Character source name field is missing');
      project.source.execute(characterMode.edit(project.source.content, card, name.id, value));
    },
    snapshot: () => ({
      source: project.source.content,
      artwork: artwork.content,
      sourceRevision: project.source.revision,
      sourceVersionId: project.source.artifact.draft.baseVersionId,
      sourceVersions: project.source.artifact.versions.length,
    }),
  };
  createRoot(document.getElementById('root')!).render(<CreativeHost project={project} />);
}
void mount().catch((error) => {
  const notice = document.createElement('p');
  notice.setAttribute('role', 'alert');
  notice.textContent = error instanceof Error ? error.message : String(error);
  document.getElementById('root')!.append(notice);
  throw error;
});
