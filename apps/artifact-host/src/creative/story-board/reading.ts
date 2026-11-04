/** Host reading only: adopted Story tables plus one fixed map, never a second source. */
import {
  canonicalJson,
  deepFreeze,
  deserializeArtifact,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import { serializeHostNativeArtifact } from '@editor-platform/editor-host';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { isDocument } from '@editor-platform/document/model';
import { validateFictionMap, type FictionMapContent } from '@editor-platform/fiction-map/model';
import { renderFictionMapSvg } from '@editor-platform/fiction-map/render';
import { settingSourceCards } from '../setting-source';
import { readWorkspaceLinks, type CreativeWorkspaceLinksV2 } from '../workspace/model';
import {
  exactSavedVersion,
  resolveTimelineProjection,
  type TimelineProjection,
  type TimelineTime,
} from '../timeline/projection';
import { readTimelineTable } from '../timeline/table';
import { convertTimelineClock, effectiveClock, rowTimeValue } from '../timeline/time';
import {
  openStoryBoard,
  BoardOpenError,
  type BoardOpenOptions,
  type OpenedStoryBoard,
} from './open';
import { boardIndividualKey, boardItemKey, type BoardItem } from './settings';

export interface BoardIndividual {
  key: string;
  character: string;
  origin: string;
  label: string;
}
export interface BoardPlace {
  key: string;
  ref: BoardItem;
  label: string;
  features: string[];
}
export interface BoardEvent {
  key: string;
  ref: BoardItem;
  label: string;
  individuals: string[];
  places: string[];
  time?: TimelineTime;
}
export interface BoardPresence {
  key: string;
  event: string;
  individual: string;
  place?: string;
  time?: TimelineTime;
  certainty: 'confirmed' | 'uncertain';
}
export interface BoardReading {
  state: 'ready';
  opened: OpenedStoryBoard;
  timeline: TimelineProjection;
  map: FictionMapContent;
  individuals: BoardIndividual[];
  places: BoardPlace[];
  events: BoardEvent[];
  presences: BoardPresence[];
  /** Immutable read-source manifest, not session revisions or a new publication. */
  adopted: { artifactId: string; versionId: string; contentHash: string }[];
  current(): boolean;
}
export type BoardReadResult = BoardReading | { state: 'partial'; current(): boolean };

export async function readStoryBoard(
  storage: Pick<StorageAdapter<Artifact<unknown>>, 'get'>,
  settingsId: string,
  inputLinks: CreativeWorkspaceLinksV2,
  options: BoardOpenOptions,
): Promise<BoardReadResult> {
  const linksIdentity = canonicalJson(inputLinks),
    links = readWorkspaceLinks(structuredClone(inputLinks)),
    opened = await openStoryBoard(storage, settingsId, options),
    generation = options.generation();
  if (links.schemaVersion !== 2 || links.story.id !== opened.settings.storyId)
    throw new BoardOpenError('invalid');
  const read = new Set<string>(),
    cache = new Map<string, Promise<Artifact<unknown> | undefined>>();
  const adopted: BoardReading['adopted'] = [];
  let partial = false;
  const current = () =>
    opened.current() &&
    linksIdentity === canonicalJson(inputLinks) &&
    Object.is(generation, options.generation()) &&
    [...read].every((id) => options.mayRead(id));
  const check = () => {
    if (!current()) throw new BoardOpenError('stale');
  };
  const get = (id: string) => {
    let pending = cache.get(id);
    if (!pending) {
      pending = (async () => {
        check();
        if (!options.mayRead(id)) {
          partial = true;
          return;
        }
        read.add(id);
        let raw: Artifact<unknown> | undefined;
        try {
          raw = await storage.get(id);
        } catch {
          check();
          throw new BoardOpenError('unavailable');
        }
        check();
        if (!raw) {
          partial = true;
          return;
        }
        try {
          const encoded = serializeHostNativeArtifact(raw);
          const artifact = deserializeArtifact(encoded);
          if (artifact.id !== id || !artifact.draft.baseVersionId) throw Error();
          const base = artifact.versions.filter(
            (v) => v.versionId === artifact.draft.baseVersionId,
          );
          if (base.length !== 1) throw Error();
          const exact = await exactSavedVersion(artifact, base[0].versionId);
          check();
          if ('reason' in exact) throw Error();
          adopted.push({
            artifactId: id,
            versionId: base[0].versionId,
            contentHash: base[0].contentHash,
          });
          // Private owned clone only; every external exact still resolves its retained version.
          artifact.draft.content = structuredClone(exact.content);
          return deepFreeze(artifact);
        } catch (error) {
          check();
          if (error instanceof BoardOpenError) throw error;
          throw new BoardOpenError('invalid');
        }
      })();
      cache.set(id, pending);
    }
    return pending;
  };
  const settings = opened.settings;
  const timeline = await resolveTimelineProjection(
    { get },
    links,
    { world: settings.world },
    options.mayRead,
  );
  check();
  const worldArtifact = await get(links.story.worldSettings);
  const world = readTimelineTable('world', worldArtifact?.draft.content);
  if (!timeline.worlds.some((w) => w.id === settings.world) || world.state !== 'valid')
    partial = true;
  const worldRows = world.state === 'valid' ? world.rows : [];
  const char = links.story.characters ? await get(links.story.characters) : undefined;
  if (links.story.characters && !isStructuredData(char?.draft.content)) partial = true;
  const characterNames = new Map(
    isStructuredData(char?.draft.content)
      ? char.draft.content.rows.map((row) => [row.id, String(row.values['ch.name'] ?? row.id)])
      : [],
  );
  const places: BoardPlace[] = [];
  for (const location of settings.locations) {
    if (places.some((p) => p.key === boardItemKey(location.place))) continue;
    const a = await get(location.place.artifactId);
    if (!a || a.kind !== 'document' || !isDocument(a.draft.content)) {
      partial = true;
      continue;
    }
    let cards;
    try {
      cards = settingSourceCards(a.draft.content);
    } catch {
      throw new BoardOpenError('invalid');
    }
    const card = cards.find((c) => c.id === location.place.itemId);
    // A deleted LO stays unconnected; never fall back by name or another heading's position.
    if (!card) continue;
    places.push({
      key: boardItemKey(location.place),
      ref: location.place,
      label: card.name,
      features: settings.locations
        .filter((l) => boardItemKey(l.place) === boardItemKey(location.place))
        .map((l) => l.featureId),
    });
  }
  const mapArtifact = await get(settings.map.artifactId);
  const versions = mapArtifact?.versions.filter((v) => v.versionId === settings.map.versionId);
  let map: FictionMapContent | undefined;
  if (
    mapArtifact &&
    versions?.length === 1 &&
    versions[0].contentHash === settings.map.contentHash
  ) {
    const saved = await exactSavedVersion(mapArtifact, settings.map.versionId);
    check();
    if (!('reason' in saved) && mapArtifact.kind === 'fiction-map') {
      const valid = validateFictionMap(saved.content);
      if (valid.ok) map = valid.value;
    }
  }
  if (!map) partial = true;
  else {
    try {
      renderFictionMapSvg(map, {
        width: 600,
        height: 400,
        view: settings.map.view,
        featureIds: settings.map.featureIds,
      });
    } catch {
      throw new BoardOpenError('invalid');
    }
  }
  const individuals = new Map<string, BoardIndividual>();
  const individual = (character: string, origin: string) => {
    const key = boardIndividualKey(links.story.namespace, character, origin);
    if (!individuals.has(key))
      individuals.set(key, {
        key,
        character,
        origin,
        label: characterNames.get(character) ?? character,
      });
    return key;
  };
  const events: BoardEvent[] = [],
    presences: BoardPresence[] = [];
  for (const ledger of links.story.ledgers.filter((l) => l.world === settings.world)) {
    const a = await get(ledger.artifactId),
      table = readTimelineTable('ledger', a?.draft.content);
    if (table.state !== 'valid') {
      partial = true;
      continue;
    }
    const defaultClock = worldRows.find((r) => r.kind === 'worldline' && r.id === ledger.world)
      ?.cells['tl1.clock'] as string | undefined;
    for (const event of timeline.events.filter((e) => e.owner === ledger.artifactId)) {
      const ref = { artifactId: event.owner, itemId: event.id },
        key = boardItemKey(ref);
      const relations = table.rows.filter((r) => r.cells['tl1.subject'] === event.id);
      const participants = [
        ...new Set(
          relations
            .filter((r) => r.cells['tl1.ind.ch'] && r.cells['tl1.ind.origin'])
            .map((r) =>
              individual(String(r.cells['tl1.ind.ch']), String(r.cells['tl1.ind.origin'])),
            ),
        ),
      ];
      const written = event.calculated?.state === 'resolved' ? event.calculated.time : event.time;
      const time =
        event.calculated?.state === 'unavailable'
          ? undefined
          : convertTimelineClock(
              { ...written, clock: effectiveClock(written.clock, defaultClock) },
              settings.clock,
              worldRows,
            );
      for (const presence of relations.filter((r) => r.kind === 'presence')) {
        const loc = String(presence.cells['tl1.loc']);
        const candidates = places.filter((p) => p.ref.itemId === loc);
        // tl1's bare LO is ambiguous when bound to multiple owners: do not choose one.
        const boundOwners = new Set(
          settings.locations
            .filter((l) => l.place.itemId === loc)
            .map((l) => boardItemKey(l.place)),
        );
        const place =
          boundOwners.size === 1 && candidates.length === 1 ? candidates[0].key : undefined;
        const subject = table.rows.find((r) => r.id === presence.cells['tl1.subject']);
        const presenceTime = {
          ...rowTimeValue(presence.cells),
          clock: effectiveClock(subject?.cells['tl1.clock'] as string | undefined, defaultClock),
        };
        presences.push({
          key: boardItemKey({ artifactId: ledger.artifactId, itemId: presence.id }),
          event: key,
          individual: individual(
            String(presence.cells['tl1.ind.ch']),
            String(presence.cells['tl1.ind.origin']),
          ),
          ...(place ? { place } : {}),
          time: convertTimelineClock(presenceTime, settings.clock, worldRows),
          certainty: presence.cells['tl1.certainty'] === 'confirmed' ? 'confirmed' : 'uncertain',
        });
      }
      events.push({
        key,
        ref,
        label: event.label,
        individuals: participants,
        places: [
          ...new Set(presences.filter((p) => p.event === key && p.place).map((p) => p.place!)),
        ],
        time,
      });
    }
  }
  check();
  if (partial || timeline.scope === 'partial' || timeline.unreadable || !map)
    return { state: 'partial', current };
  if (individuals.size > 200) throw new BoardOpenError('invalid');
  return deepFreeze({
    state: 'ready',
    opened,
    timeline,
    map,
    individuals: [...individuals.values()],
    places,
    events,
    presences,
    adopted: adopted.filter((source) => source.artifactId !== settings.map.artifactId),
    current,
  });
}
