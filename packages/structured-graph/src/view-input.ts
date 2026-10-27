import { type RefObject } from 'react';
import { useEditorInput } from '@editor-platform/editor-ui';
import { prepareGraphAttributeDraft, type GraphAttributeDraft } from './attribute-draft';
import { type GraphDocument } from './model';
import { type GraphProfile } from './profile';
import { graphCommand, type GraphIntent } from './commands';
import { type GraphConnectionInput } from './view-connection';
import { graphDraftTarget, hasComposingDraft, type GraphApply } from './view-model';

export interface GraphEditorInputContext {
  readOnly: boolean;
  graph: GraphDocument;
  profile: GraphProfile;
  stamp: string;
  drafts: RefObject<Map<string, GraphAttributeDraft>>;
  invalidInput: RefObject<string | undefined>;
  connection: GraphConnectionInput;
  setConnection: (update: (connection: GraphConnectionInput) => GraphConnectionInput) => void;
  prepareConnection: () => GraphIntent;
  apply: GraphApply;
  choose: (id: string) => boolean;
  root: RefObject<HTMLDivElement | null>;
}

function graphDraftIntents({ drafts, invalidInput, graph, profile }: GraphEditorInputContext) {
  const intents: GraphIntent[] = [];
  for (const [id, draft] of drafts.current) {
    invalidInput.current = id;
    const target = graphDraftTarget(draft, id, graph, profile);
    if (!target || target.type.readOnly)
      throw new Error('対象が削除済み、または編集できない定義です。');
    intents.push(...prepareGraphAttributeDraft(draft, target.attributes, target.type.schema));
  }
  return intents;
}

function prepareGraphInput(context: GraphEditorInputContext) {
  const { readOnly, connection, invalidInput, profile, graph, apply, stamp, drafts } = context;
  if (readOnly) throw new Error('このHostではGraphを編集できません。');
  const intents = graphDraftIntents(context);
  if (connection.dirty) {
    invalidInput.current = connection.target;
    intents.push(context.prepareConnection());
  }
  graphCommand(profile, intents).apply(graph);
  return () => {
    if (intents.length && !apply(intents, stamp)) return false;
    drafts.current.clear();
    context.setConnection((connection) => ({ ...connection, dirty: false }));
  };
}

function focusGraphInput({ choose, invalidInput, drafts, graph, root }: GraphEditorInputContext) {
  choose(invalidInput.current ?? drafts.current.keys().next().value ?? graph.id);
  setTimeout(
    () =>
      root.current
        ?.querySelector<HTMLElement>(
          '.ep-graph-inspector input, .ep-graph-inspector select, .ep-graph-inspector textarea',
        )
        ?.focus(),
    0,
  );
}

/** Registers attribute drafts and the connection buffer with the Host input boundary. */
export function useGraphEditorInput(context: GraphEditorInputContext) {
  useEditorInput({
    label: 'Graph',
    read: () => ({
      dirty: context.drafts.current.size > 0 || context.connection.dirty,
      composing: hasComposingDraft(context.drafts.current) || !!context.connection.composing,
    }),
    prepare: () => prepareGraphInput(context),
    focus: () => focusGraphInput(context),
  });
}
