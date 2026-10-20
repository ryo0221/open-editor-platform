# Running and embedding the collaboration reference

This guide describes the Issue #3 **verification Lab and reference Host**.
For the normal editor's current shared mode and the independent Host example, use
[the Issue #5 integration guide](editor-collaboration-integration.md). The Lab remains a
focused foundation test fixture and does not replace the normal toolbar/canvas UI.

## Responsibilities at the adapter boundary

| Owner                              | Responsibility                                                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor Platform                    | Domain models/operations, editing merge and conflict rules, transactions, actor/session Undo/Redo, text/selection/annotation mapping, proposal content preview and precondition validation, editing state and in-document presence rendering. |
| Collaboration Platform             | Organizations, Rooms, membership, joining/leaving and invitations, authenticated identity, access policy and enforcement, Room–Artifact relationships.                                                                                        |
| Trusted Collaboration/Host adapter | Authenticated sessions and permitted operation scopes, update submission/delivery, receipts/reconnect, connection and expiry notifications, presence transport, production persistence.                                                       |
| Host Product / Runtime             | Entry into shared editing, organization/Room UI, agent generation/execution/regeneration and adoption policy; organizational approval workflows remain outside Editor.                                                                        |

The Host maps organization/Room policy to an artifact/session and allowed scopes.
Editor consumes opaque identities and those capabilities; it does not infer roles,
maintain a membership database or embed Room semantics in domain/native content.
The trusted Host/adapter enforces current authorization at submission and commit,
including revocation/expiry. Disabling an Editor button is insufficient.

The reference `Authority` compares operations against a Host-supplied trusted
`Principal` at its commit boundary, in addition to checking content invariants.
This is a generic enforcement hook, not an organization policy engine: wire actor
claims cannot create a principal, expand scopes or declare authority-only
provenance; proposal registration, review and cancellation take the same principal.
`createReferenceServer()` in `apps/collaboration-reference/src/server.ts` holds the
reference Host state per instance for its unit tests; `main.ts` only listens. A production integration must
bind and refresh authorization from Collaboration before reaching that boundary.
Editor then handles typed rejection, pending work and session-expiry notifications.
Demo rooms, A/B/C selectors, bearer bindings and the in-memory server belong only to
the reference Host. Do not duplicate a production Collaboration Platform in this repo.

## Run the Lab

Node 24.19.0 and the normal `npm ci` install are sufficient. No API key or external
service is used. Keep two task-owned processes running:

```sh
npm run collaboration:server # in-memory HTTP authority, loopback port 4180
npm run dev                  # Vite, port 5173, proxies /collaboration-api
```

Open the application's `/collaboration.html` entry. Choose A and use “Open human B”
in a separate browser context/profile; both URLs retain the same room identifier.
Use Slide, Data or Document to edit independently. On Slide, generate C's proposal,
preview it, change shape1's color as B, then apply as A: the read dependency conflicts.
Generate again, preview, move shape1 instead, then apply: the independent edit remains.
Disconnect A, make a pending relative move, edit as B, reconnect and inspect receipts.
Undo my edit and Export confirmed operate on shared accepted state.

Playwright starts the authority automatically; the production config starts preview
port 4173 with the same proxy. Readiness can be checked without a browser with
`curl --fail http://127.0.0.1:4180/collaboration-api/health`.

For a network-free Host:

```ts
import {
  Authority,
  initial,
  localAdapter,
  CollaborationClient,
  operation,
} from '@editor-platform/collaboration-core';
import { slideCodec, move } from '@editor-platform/collaboration-adapters';

const authority = new Authority(slideCodec, initial(artifactId, slideCodec, deck));
// Host supplies authenticated identity and authorization; never copy these from a wire operation.
const adapter = localAdapter(authority, principal);
const client = new CollaborationClient(slideCodec, adapter);
await client.open();
await client.submit(
  operation(slideCodec, client.confirmed, adapter.identity, [move(shapeId, 20, 0)]),
);
```

The domain operation and acceptance contract is identical with HttpSyncAdapter.
For Document, use DocumentReplica and its EditorState/dispatch/flush interface; do
not flatten rich text into canvas field sets or EditorSession snapshot commands.

A production adapter must validate artifact access on every connection/route,
persist an atomic canonical transaction and dedup receipt, enforce session expiry
and scopes, subscribe/buffer ordered updates, expose receipt lookup and checkpoints,
and validate external dependencies through a Host lease/version policy. The example
HTTP identity selector is intentionally not real login. The server binds loopback;
Vite is the development proxy. It is not intended as a public production deployment.

The authority emits snapshot-bearing events for inspectability and retains inverse
and dedup history in memory. Replace these storage/transport choices for production
without changing domain semantics or inferring durability from `accepted`.
