/**
 * AR2 (docs/analysis-references-design.md U4): a made-up `ItemReferenceHost` for the Playground.
 * Candidates are the business items of the other saved artifacts in this Library (Fishbone, FMEA,
 * FTA and any Graph or Data that declares items). `select` records the saved version a person
 * chose; a save sends the selection evidence, and the Host keeps that version as the citation's
 * basis and reports `stale` once the target's saved item differs. A real Host (PaoBub) keeps the
 * basis per citation occurrence and decides acceptance; this one only shows the flow.
 */
import type { MutableRefObject } from 'react';
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import type {
  ItemCandidate,
  ItemReferenceHost,
  ItemRefOccurrence,
  ItemRefSource,
  ItemRefState,
  ItemSelectionEvidence,
} from '@editor-platform/artifact-references/items';
import { readItems, type ReadItems } from '@editor-platform/extension-runtime/items';
import {
  graphItemsDeclaration,
  isGraphDocument,
  type GraphDocument,
} from '@editor-platform/structured-graph/model';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import {
  dataItemsDeclaration,
  rowReferenceEntries,
  rowReferenceIds,
} from '@editor-platform/structured-data/items';
import { graphProfileFor } from './graph-templates';
import type { StoredArtifact } from '../model';

/** One business item of a saved artifact. */
interface FoundItem {
  id: string;
  title: string;
  artifactId: string;
  artifactTitle: string;
  /** Native element IDs (nodes or rows) that hold the ID, for opening. */
  elements: string[];
  fingerprint: string;
}

const SELECTION_HOURS = 24;

/** The items and duplicates of one content (latest saved version or draft). */
export function itemsOfContent(
  content: unknown,
): { read: ReadItems; native: (key: string) => string | undefined } | undefined {
  if (isGraphDocument(content)) {
    const profile = graphProfileFor(content);
    const declaration = profile && graphItemsDeclaration(profile);
    if (!declaration) return undefined;
    const doc = content as GraphDocument;
    return {
      read: readItems(declaration, doc, () => undefined),
      native: (k) => doc.nodes[Number(k)]?.id,
    };
  }
  if (isStructuredData(content)) {
    const declaration = dataItemsDeclaration(content);
    if (!declaration) return undefined;
    const data = content as StructuredData;
    return {
      read: readItems(declaration, data, () => undefined),
      native: (k) => data.rows[Number(k)]?.id,
    };
  }
  return undefined;
}

/** Each cited ID at each reference field of a content: what a save compares to the previous save. */
export function refOccurrences(artifactId: string, content: unknown): ItemRefOccurrence[] {
  const out: ItemRefOccurrence[] = [];
  if (isGraphDocument(content)) {
    const profile = graphProfileFor(content);
    for (const node of content.nodes) {
      const refs = profile?.nodes[node.type]?.items?.refs ?? [];
      for (const field of refs) {
        const v = node.attributes[field];
        const ids = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
        for (const id of ids)
          if (typeof id === 'string' && id)
            out.push({ from: { artifactId, elementId: node.id, field }, id });
      }
    }
  } else if (isStructuredData(content)) {
    for (const row of content.rows)
      for (const field of rowReferenceEntries(content, row))
        for (const id of rowReferenceIds(row, field))
          out.push({ from: { artifactId, elementId: row.id, field }, id });
  }
  return out;
}

const key = (from: ItemRefSource, id: string) =>
  JSON.stringify([from.artifactId, from.elementId, from.field, id]);

export interface PlaygroundItemHost extends ItemReferenceHost {
  /**
   * After a save of `artifactId` committed: use each unconsumed, unexpired selection whose source
   * and ID match the saved citation as that citation's basis. Others carry no evidence.
   */
  committed(
    artifactId: string,
    evidence: readonly ItemSelectionEvidence[],
    saved: readonly ItemRefOccurrence[],
  ): void;
}

export function playgroundItemHost(context: {
  saved: MutableRefObject<Map<string, StoredArtifact>>;
  notifications: MutableRefObject<Set<(id: string) => void>>;
  /** Opens the target artifact focused on the cited element; the return address is `from`. */
  navigation: MutableRefObject<
    (targetArtifactId: string, targetElementId: string, from: ItemRefSource) => boolean
  >;
  now?: () => number;
}): PlaygroundItemHost {
  const now = context.now ?? (() => Date.now());
  const selections = new Map<
    string,
    { from: ItemRefSource; id: string; fingerprint: string; at: number; consumed: boolean }
  >();
  /** Basis per citation (source field and cited ID): the fingerprint of the version chosen. */
  const basis = new Map<string, string>();
  function catalog(exclude?: string) {
    const items = new Map<string, FoundItem[]>();
    const duplicated = new Set<string>();
    for (const a of context.saved.current.values()) {
      if (a.id === exclude) continue;
      const found = itemsOfContent(a.versions.at(-1)?.content);
      if (!found) continue;
      for (const d of found.read.duplicates ?? []) duplicated.add(d.id);
      for (const it of found.read.items) {
        const list = items.get(it.id) ?? [];
        list.push({
          id: it.id,
          title: it.title || it.id,
          artifactId: a.id,
          artifactTitle: a.name,
          elements: (it.elements ?? [it.key]).flatMap((k) => found.native(k) ?? []),
          fingerprint: canonicalJson(it.body),
        });
        items.set(it.id, list);
      }
    }
    // The same ID in two artifacts resolves to neither
    for (const [id, list] of items) if (list.length > 1) duplicated.add(id);
    return { items, duplicated };
  }
  function stateOf(from: ItemRefSource, id: string): ItemRefState {
    const { items, duplicated } = catalog(from.artifactId);
    if (duplicated.has(id)) return { status: 'duplicate', reason: `${id} が二つ以上あります` };
    const it = items.get(id)?.[0];
    if (!it) return { status: 'unresolved', reason: `${id} は Library の保存した版にありません` };
    const b = basis.get(key(from, id));
    if (b !== undefined && b !== it.fingerprint)
      return {
        status: 'stale',
        reason: `選んだ版から ${it.artifactTitle} の ${id} が変わりました`,
      };
    return { status: 'ok', title: it.title };
  }
  return {
    async candidates(from) {
      const { items, duplicated } = catalog(from.artifactId);
      const out: ItemCandidate[] = [];
      for (const [id, list] of items)
        if (!duplicated.has(id))
          out.push({ id, title: list[0]!.title, artifactTitle: list[0]!.artifactTitle });
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async resolve(from, ids) {
      return new Map(ids.map((id) => [id, stateOf(from, id)]));
    },
    async open(id, from) {
      const state = stateOf(from, id);
      if (state.status !== 'ok' && state.status !== 'stale' && state.status !== 'kept')
        return { opened: false, state };
      const it = catalog(from.artifactId).items.get(id)![0]!;
      return context.navigation.current(it.artifactId, it.elements[0] ?? '', { ...from })
        ? { opened: true }
        : { opened: false, state: { status: 'offline', reason: '開けませんでした' } };
    },
    async select(from, id) {
      const state = stateOf(from, id);
      if (state.status !== 'ok' && state.status !== 'stale') return { accepted: false, state };
      const it = catalog(from.artifactId).items.get(id)![0]!;
      const record = context.saved.current.get(it.artifactId)!;
      const version = record.versions.at(-1)!;
      const selectionId = newId('selection');
      selections.set(selectionId, {
        from: { ...from },
        id,
        fingerprint: it.fingerprint,
        at: now(),
        consumed: false,
      });
      return {
        accepted: true,
        selectionId,
        target: {
          artifactId: it.artifactId,
          versionId: version.versionId,
          revision: record.versions.length,
          contentHash: version.contentHash,
        },
        state: { status: 'ok', title: it.title },
      };
    },
    subscribe(notify) {
      const listener = () => notify();
      context.notifications.current.add(listener);
      return () => context.notifications.current.delete(listener);
    },
    committed(artifactId, evidence, saved) {
      const present = new Set(saved.map((o) => key(o.from, o.id)));
      // A citation that is no longer saved ends its basis; adding it again needs a new selection
      for (const k of [...basis.keys()])
        if (JSON.parse(k)[0] === artifactId && !present.has(k)) basis.delete(k);
      for (const e of evidence) {
        const s = selections.get(e.selectionId);
        if (!s || s.consumed || now() - s.at > SELECTION_HOURS * 3_600_000) continue;
        if (key(s.from, s.id) !== key(e.from, e.id) || !present.has(key(e.from, e.id))) continue;
        s.consumed = true;
        basis.set(key(e.from, e.id), s.fingerprint);
      }
    },
  };
}
