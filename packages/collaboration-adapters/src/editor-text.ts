import { EditorState, TextSelection, Plugin, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { collab, getVersion, receiveTransaction, sendableSteps } from 'prosemirror-collab';
import { Step, Mapping } from 'prosemirror-transform';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { canvasTextSchema, canvasTextValue } from '@editor-platform/canvas-ui/text-engine';
import {
  contentToNode,
  nodeToContent,
  documentPlugins,
  documentSchema,
} from '@editor-platform/document/engine';
import type { DocumentContent } from '@editor-platform/document/model';
import {
  canonical,
  fail,
  operation,
  type Accepted,
  type Anchor,
  type Operation,
  type Snapshot,
} from '@editor-platform/collaboration-core';
import { canvasEngineDocument, canvasTextItem } from './canvas-text';
import type { SharedEditorSession } from './editor-session';
import type { AssetEditorCodec } from './editor-assets';

/** The text state is a part of the owning editing session, not another persistence/Undo owner. */
export class EditorTextEngine<T> {
  state: EditorState;
  private inflight?: string;
  private listeners = new Set<() => void>();
  conflict = '';
  private canonicalText: string;
  private awaitingInsertion?: string;
  constructor(
    readonly session: SharedEditorSession<T>,
    readonly target: string,
    checkpoint?: ReturnType<EditorTextEngine<T>['checkpoint']>,
  ) {
    this.awaitingInsertion = checkpoint?.insertion;
    try {
      this.state =
        checkpoint?.basis && (checkpoint.insertion || checkpoint.conflict)
          ? this.create(session.confirmed, checkpoint.basis, checkpoint.version)
          : this.create(session.confirmed);
    } catch (error) {
      if ((error as { code?: string }).code !== 'target-deleted') throw error;
      this.awaitingInsertion ??= session.pendingTextInsertion(target);
      if (checkpoint?.basis && (this.awaitingInsertion || checkpoint.conflict))
        this.state = this.create(session.confirmed, checkpoint.basis, checkpoint.version);
      else if (this.awaitingInsertion) this.state = this.create(session.client.optimistic);
      else throw error;
    }
    this.canonicalText = canonical(this.state.doc.toJSON());
  }
  get isDocument() {
    return this.session.codec.domain === 'document';
  }
  private get schema() {
    return this.isDocument ? documentSchema : canvasTextSchema;
  }
  private document(content: T) {
    return this.isDocument
      ? contentToNode(content as DocumentContent)
      : canvasEngineDocument(this.session.codec, content, this.target);
  }
  private version(snapshot: Snapshot<T>) {
    return this.isDocument ? snapshot.engineVersion : (snapshot.textVersions?.[this.target] ?? 0);
  }
  private create(
    snapshot: Snapshot<T>,
    engineDocument?: unknown,
    version = this.version(snapshot),
  ) {
    const schema = this.schema;
    return EditorState.create({
      doc: engineDocument ? schema.nodeFromJSON(engineDocument) : this.document(snapshot.content),
      plugins: [
        keymap({
          'Mod-Home': (state, dispatch) => {
            dispatch?.(state.tr.setSelection(TextSelection.atStart(state.doc)));
            return true;
          },
          'Mod-End': (state, dispatch) => {
            dispatch?.(state.tr.setSelection(TextSelection.atEnd(state.doc)));
            return true;
          },
        }),
        ...(this.isDocument
          ? documentPlugins()
          : [
              keymap({
                'Mod-b': toggleMark(schema.marks.bold),
                'Mod-i': toggleMark(schema.marks.italic),
                'Mod-u': toggleMark(schema.marks.underline),
              }),
              keymap(baseKeymap),
            ]),
        collab({
          version,
          clientID: this.session.adapter.identity.clientId,
        }),
        new Plugin({
          props: {
            decorations: (state) => {
              const decorations: Decoration[] = [];
              for (const presence of this.session.presences) {
                const original = presence.anchor;
                if (
                  !original ||
                  original.orphan ||
                  (this.isDocument
                    ? original.type !== 'text'
                    : original.type !== 'canvas-text' || original.elementId !== this.target)
                )
                  continue;
                const anchor = this.localAnchor(original);
                if (anchor.type !== 'text' && anchor.type !== 'canvas-text') continue;
                if (anchor.from < 0 || anchor.to > state.doc.content.size || anchor.orphan)
                  continue;
                if (anchor.from < anchor.to)
                  decorations.push(
                    Decoration.inline(anchor.from, anchor.to, {
                      style: 'background: #8b5cf633',
                      'data-presence': presence.actorId,
                    }),
                  );
                decorations.push(
                  Decoration.widget(
                    anchor.from,
                    () => {
                      const cursor = document.createElement('span');
                      cursor.className = 'shared-text-caret';
                      cursor.title = presence.name;
                      cursor.style.cssText =
                        'border-left:2px solid #8b5cf6;display:inline-block;width:0;height:1em;pointer-events:none';
                      cursor.contentEditable = 'false';
                      cursor.setAttribute('aria-label', `${presence.name} cursor`);
                      cursor.setAttribute('data-presence', presence.actorId);
                      return cursor;
                    },
                    { key: presence.clientId, side: -1, ignoreSelection: true },
                  ),
                );
              }
              return DecorationSet.create(state.doc, decorations);
            },
          },
        }),
      ],
    });
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    // An idle engine may outlive a deleted canvas element (including a normal
    // local delete). Only unsent text needs a global recovery warning.
    if (this.conflict && this.pending) this.session.error = this.conflict;
    this.listeners.forEach((fn) => fn());
    this.session.onChange();
  }
  refreshPresence() {
    this.state = this.state.apply(this.state.tr.setMeta('presence', true));
    this.listeners.forEach((fn) => fn());
  }
  get pending() {
    return !!sendableSteps(this.state);
  }
  get unsubmitted() {
    return this.pending && !this.inflight;
  }
  reset(snapshot: Snapshot<T>) {
    if (this.awaitingInsertion) return; // Receipt recovery attaches after snapshot installation.
    if (this.pending)
      this.conflict = 'Text history compacted; pending input retained in checkpoint';
    else {
      try {
        this.state = this.create(snapshot);
        this.canonicalText = canonical(this.state.doc.toJSON());
        this.conflict = '';
      } catch (error) {
        if (this.isDocument) throw error;
        this.conflict = 'Text target was deleted';
      }
    }
    this.notify();
  }
  discardPending() {
    this.state = this.create(this.session.confirmed);
    this.canonicalText = canonical(this.state.doc.toJSON());
    this.awaitingInsertion = undefined;
    this.inflight = undefined;
    this.conflict = '';
    this.notify();
  }
  cancelUnsubmitted(id: string) {
    if (this.inflight === id) this.discardPending();
  }
  retry() {
    if (this.conflict && !this.conflict.startsWith('unauthorized:'))
      fail('resync-required', this.conflict);
    this.conflict = '';
    this.notify();
  }
  dispatch(transaction: Transaction) {
    if (transaction.docChanged && this.session.readOnly)
      fail('unauthorized', 'Text session is read only or expired');
    if (transaction.docChanged && this.conflict) fail('resync-required', this.conflict);
    this.state = this.state.applyTransaction(transaction).state;
    this.session.textSelection(this.target, this.state.selection.from, this.state.selection.to);
    this.notify();
    this.session.scheduleText();
  }
  history(direction: 'undo' | 'redo') {
    void this.session.history(direction).catch((e) => {
      this.session.error = String(e);
      this.notify();
    });
  }
  prepare(): Operation | undefined {
    if (this.awaitingInsertion) {
      if (this.session.client.receipts.get(this.awaitingInsertion)?.status !== 'accepted') return;
      this.acceptInsertion(this.session.confirmed);
    }
    const steps = sendableSteps(this.state);
    if (!steps || this.inflight || this.conflict) return;
    const op = operation(
      this.session.codec,
      this.session.confirmed,
      this.session.adapter.identity,
      [
        {
          type: this.isDocument ? 'document.steps' : 'canvas.text-steps',
          target: this.target,
          payload: { version: steps.version, steps: steps.steps.map((s) => s.toJSON()) },
        },
      ],
    );
    this.inflight = op.operationId;
    return op;
  }
  rejected(op: Operation, code: string, message: string) {
    if (op.operationId === this.awaitingInsertion) {
      this.conflict = `${code}: ${message}. Insertion and pending text retained for review.`;
      this.notify();
      return false;
    }
    if (this.inflight !== op.operationId) return false;
    this.inflight = undefined;
    if (code !== 'resync-required') this.conflict = `${code}: ${message}. Pending text retained.`;
    this.notify();
    return code === 'resync-required';
  }
  receive(event: Accepted<T>) {
    if (this.awaitingInsertion) {
      if (this.session.confirmsIntent(this.awaitingInsertion, event))
        this.acceptInsertion(event.snapshot);
      return;
    }
    if (event.operation.actions.some((a) => a.type === 'domain.restore') && this.pending) {
      this.conflict = 'A restored version changed the text basis; pending text retained for review';
      this.notify();
      return;
    }
    const actions = event.operation.actions.filter((a) =>
      this.isDocument
        ? a.type === 'document.steps'
        : a.type === 'canvas.text-steps' && a.target === this.target,
    );
    const assets = (this.session.codec as AssetEditorCodec<T>).assets;
    // Incoming snapshots contain materialized domain images, so seed the private cache.
    assets?.encode(event.snapshot.content);
    const json = this.isDocument
      ? event.engineSteps
      : actions.flatMap(
          (a) => (assets ? assets.decode(a.payload.steps) : a.payload.steps) as unknown[],
        );
    if (json.length) {
      const own = event.operation.operationId === this.inflight;
      this.state = this.state.apply(
        receiveTransaction(
          this.state,
          json.map((s) => Step.fromJSON(this.schema, s)),
          json.map(() =>
            own ? this.session.adapter.identity.clientId : `remote:${event.operation.operationId}`,
          ),
        ),
      );
      if (own) this.inflight = undefined;
    } else {
      try {
        const now = canonical(this.document(event.snapshot.content).toJSON());
        if (now !== this.canonicalText || this.conflict === 'Text target was deleted') {
          if (this.pending)
            this.conflict =
              'Text changed by a structural operation; pending input retained for review';
          else {
            const position = this.state.selection.from;
            this.state = this.create(event.snapshot);
            this.conflict = '';
            this.state = this.state.apply(
              this.state.tr.setSelection(
                TextSelection.near(
                  this.state.doc.resolve(Math.min(position, this.state.doc.content.size)),
                ),
              ),
            );
          }
        }
      } catch {
        this.conflict = this.pending
          ? 'Text target was deleted; pending input retained in checkpoint'
          : 'Text target was deleted';
      }
    }
    try {
      this.canonicalText = canonical(this.document(event.snapshot.content).toJSON());
    } catch {
      /* deleted */
    }
    this.session.mapTextSelection(this.target, this.state.selection.from, this.state.selection.to);
    this.notify();
    this.session.scheduleText();
  }
  private acceptInsertion(snapshot: Snapshot<T>) {
    try {
      const next = this.create(snapshot);
      if (canonical(next.doc.toJSON()) !== this.canonicalText)
        fail('resync-required', 'Inserted text basis changed; pending input retained for review');
      const tr = next.tr;
      for (const step of sendableSteps(this.state)?.steps ?? []) tr.step(step);
      this.state = next.apply(tr);
      this.awaitingInsertion = undefined;
      this.conflict = '';
      this.session.scheduleText();
    } catch (error) {
      this.conflict = String(error);
    }
    this.notify();
  }
  project(content: T): T {
    if (!this.pending) return content;
    if (this.isDocument) return nodeToContent(this.state.doc, content as DocumentContent) as T;
    try {
      const { item, style } = canvasTextItem(this.session.codec, content, this.target);
      Object.assign(item, canvasTextValue(this.state.doc, style));
    } catch {
      /* removed target */
    }
    return content;
  }
  localAnchor(anchor: Anchor, alreadyApplied = 0): Anchor {
    if ((anchor.type !== 'text' && anchor.type !== 'canvas-text') || anchor.orphan) return anchor;
    const mapping = new Mapping(
      (sendableSteps(this.state)?.steps ?? []).slice(alreadyApplied).map((s) => s.getMap()),
    );
    const from = mapping.mapResult(anchor.from, 1),
      to = mapping.mapResult(anchor.to, -1);
    return {
      ...anchor,
      from: from.pos,
      to: Math.max(from.pos, to.pos),
      orphan: from.deletedAcross && to.deletedAcross,
    };
  }
  /** Opaque comparison inputs for the owning session's recovery revision. */
  get recoveryState(): readonly unknown[] {
    return [
      this.state.doc,
      getVersion(this.state),
      this.inflight,
      this.conflict,
      this.canonicalText,
      this.awaitingInsertion,
    ];
  }
  checkpoint() {
    return {
      target: this.target,
      version: getVersion(this.state),
      steps: sendableSteps(this.state)?.steps.map((s) => s.toJSON()) ?? [],
      inflight: this.inflight,
      conflict: this.conflict,
      insertion: this.awaitingInsertion,
      basis: JSON.parse(this.canonicalText) as unknown,
    };
  }
  resume(checkpoint: ReturnType<EditorTextEngine<T>['checkpoint']>) {
    if (checkpoint.version !== getVersion(this.state))
      fail('resync-required', 'Text checkpoint needs its original confirmed snapshot');
    const tr = this.state.tr;
    for (const step of checkpoint.steps) tr.step(Step.fromJSON(this.schema, step));
    this.state = this.state.apply(tr);
    this.inflight = checkpoint.inflight;
    this.conflict = checkpoint.conflict;
    this.notify();
  }
}
