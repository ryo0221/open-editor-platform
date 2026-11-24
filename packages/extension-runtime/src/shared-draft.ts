import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  canonical,
  fingerprint,
  serializable,
  type Principal,
  type Receipt,
} from '@editor-platform/collaboration-core';
import { admittedCodec, type VerifiedPackage, type PackagePinLookup } from './package';
import {
  CodecUnavailable,
  validateSharedContent,
  sharedAnchorExists,
  evaluateShared,
  prepareSharedEdit,
  type SharedRequest,
  type SharedSnapshot,
} from './shared-edit';

export interface HistoryRequest {
  generation: string;
  operationId: string;
  direction: 'undo' | 'redo';
  target: string;
}
export interface SharedConnection {
  /** Trusted Host callbacks; each call must recheck access and connection ownership. */
  principal(): Principal;
  readable(): boolean;
  namespace: string;
  canMigrate?(): boolean;
}
const DAY = 86_400_000;
const MAX_RECEIPTS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireId(namespace: string, id: string) {
  if (
    typeof id !== 'string' ||
    !id.startsWith(namespace + '/') ||
    !UUID.test(id.slice(namespace.length + 1))
  )
    throw Error('protocol-error');
}
/** Node reference storage. Keep one Host-owned database per artifact. All writes use SQL transactions. */
export class SharedDraft<T> {
  private db: DatabaseSync;
  static async open<T>(
    path: string,
    verified: VerifiedPackage,
    codecPin: PackagePinLookup,
    artifactId: string,
    initial: T,
  ) {
    const checked = await validateSharedContent(verified, codecPin, initial);
    return new SharedDraft(path, verified, codecPin, artifactId, checked);
  }
  private constructor(
    path: string,
    private verified: VerifiedPackage,
    private codecPin: PackagePinLookup,
    private artifactId: string,
    initial: T,
  ) {
    const codec = admittedCodec(verified, codecPin);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS draft(id INTEGER PRIMARY KEY CHECK(id=1), artifact TEXT, pin TEXT, generation TEXT, revision INTEGER, parent TEXT);
      CREATE TABLE IF NOT EXISTS snapshots(revision INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(generation TEXT,id TEXT,actor TEXT,digest TEXT,result TEXT,expires INTEGER, PRIMARY KEY(generation,id));
      CREATE INDEX IF NOT EXISTS actor_receipts ON receipts(generation,actor);
      CREATE TABLE IF NOT EXISTS effects(revision INTEGER PRIMARY KEY,id TEXT NOT NULL,actor TEXT NOT NULL,session TEXT NOT NULL,inverseOf TEXT,keys TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, actor TEXT, session TEXT, direction TEXT, revision INTEGER, base TEXT, inverse TEXT);
      CREATE TABLE IF NOT EXISTS migration(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, generation TEXT, author TEXT, request TEXT, accepted TEXT, adopter TEXT);
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,actor TEXT,request TEXT UNIQUE,digest TEXT,body TEXT);
      CREATE TABLE IF NOT EXISTS rates(generation TEXT,session TEXT,at INTEGER,tokens REAL,PRIMARY KEY(generation,session));
    `);
    try {
      this.atomic(() => {
        const row = this.db.prepare('SELECT * FROM draft').get();
        if (row) {
          if (row.artifact !== artifactId || row.pin !== verified.manifest.packageHash)
            throw Error('schema-mismatch');
          return;
        }
        if (!serializable(initial)) throw Error('Invalid initial snapshot');
        const generation = randomUUID();
        this.db
          .prepare('INSERT INTO draft VALUES(1,?,?,?,0,NULL)')
          .run(artifactId, verified.manifest.packageHash, generation);
        this.db
          .prepare('INSERT INTO snapshots VALUES(0,?)')
          .run(
            JSON.stringify({ artifactId, generation, revision: 0, stamps: {}, content: initial }),
          );
        codec.assertTrusted();
      });
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  private atomic<R>(run: () => R): R {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private auth(connection: SharedConnection, write = false) {
    admittedCodec(this.verified, this.codecPin);
    if (this.db.prepare('SELECT pin FROM draft').get()?.pin !== this.verified.manifest.packageHash)
      throw Error('schema-mismatch');
    const p = connection.principal();
    if (
      !connection.readable() ||
      !this.verified.manifest.permissions.includes('artifact:read') ||
      (p.expiresAt !== undefined && p.expiresAt <= Date.now()) ||
      (write && (!p.writable || !this.verified.manifest.permissions.includes('artifact:write')))
    )
      throw Error('unauthorized');
    return p;
  }
  private assertEditing() {
    if (this.db.prepare('SELECT id FROM migration WHERE expires>?').get(Date.now()))
      throw Error('migration-in-progress');
  }
  private read(revision?: number): SharedSnapshot<T> {
    const row = this.db
      .prepare('SELECT body FROM snapshots WHERE revision=COALESCE(?,(SELECT revision FROM draft))')
      .get(revision ?? null);
    if (!row) throw Error('resync-required');
    return JSON.parse(String(row.body));
  }
  async validatePresence(connection: SharedConnection, target: string) {
    this.auth(connection);
    if (typeof target !== 'string' || !target || target.length > 200)
      throw Error('invalid-operation');
    const base = this.read();
    const valid = await sharedAnchorExists(this.verified, this.codecPin, base.content, target);
    this.auth(connection);
    const current = this.read();
    return valid && base.generation === current.generation && base.revision === current.revision;
  }
  savedParent(connection: SharedConnection) {
    this.auth(connection);
    return this.db.prepare('SELECT parent FROM draft').get()?.parent ?? null;
  }
  snapshot(connection: SharedConnection) {
    this.auth(connection);
    return this.read();
  }
  receipt(connection: SharedConnection, generation: string, id: string): Receipt | undefined {
    const p = this.auth(connection);
    const row = this.db
      .prepare(
        'SELECT result FROM receipts WHERE generation=? AND id=? AND actor=? AND (expires IS NULL OR expires>?)',
      )
      .get(generation, id, p.actorId, Date.now());
    return row ? JSON.parse(String(row.result)) : undefined;
  }
  private budget(generation: string, p: Principal) {
    const now = Date.now();
    const row = this.db
      .prepare('SELECT at,tokens FROM rates WHERE generation=? AND session=?')
      .get(generation, p.sessionId);
    const tokens = row
      ? Math.min(20, Number(row.tokens) + Math.max(0, now - Number(row.at)) / 100)
      : 20;
    if (tokens < 1) throw Error('rate-limited');
    const rejects = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM receipts WHERE generation=? AND actor=? AND json_extract(result,'$.status')='rejected'",
      )
      .get(generation, p.actorId);
    if (Number(rejects?.n) >= 500) throw Error('rate-limited');
    this.db
      .prepare('INSERT OR REPLACE INTO rates VALUES(?,?,?,?)')
      .run(generation, p.sessionId, now, tokens - 1);
  }
  private rotate(snapshot: SharedSnapshot<T>) {
    const old = snapshot.generation;
    const generation = randomUUID();
    this.db
      .prepare('UPDATE receipts SET expires=? WHERE generation=?')
      .run(Date.now() + 7 * DAY, old);
    this.db.prepare('DELETE FROM rates WHERE generation=?').run(old);
    this.db.exec(
      'DELETE FROM snapshots; DELETE FROM effects; DELETE FROM history; DELETE FROM proposals',
    );
    this.db
      .prepare('INSERT INTO snapshots VALUES(?,?)')
      .run(snapshot.revision, JSON.stringify({ ...snapshot, generation }));
    this.db.prepare('UPDATE draft SET generation=?').run(generation);
  }
  /** Compute a preview under the admitted new codec. Confirmation rechecks the exact
   * source generation, revision and both pins before committing the migration. */
  async previewMigration(
    connection: SharedConnection,
    next: VerifiedPackage,
    lookup: PackagePinLookup,
  ) {
    this.auth(connection, true);
    if (!connection.canMigrate?.()) throw Error('unauthorized');
    const token = randomUUID();
    const base = this.atomic(() => {
      this.assertEditing();
      this.db
        .prepare('INSERT OR REPLACE INTO migration VALUES(1,?,?)')
        .run(token, Date.now() + 300_000);
      return this.read();
    });
    const cancel = () => {
      this.db.prepare('DELETE FROM migration WHERE token=?').run(token);
    };
    let content: T;
    try {
      content = await validateSharedContent(
        next,
        lookup,
        base.content,
        this.verified.manifest.packageHash,
      );
    } catch (error) {
      cancel();
      throw error;
    }
    const commit = () =>
      this.atomic(() => {
        this.auth(connection, true);
        if (!connection.canMigrate?.()) throw Error('unauthorized');
        admittedCodec(next, lookup);
        if (
          !this.db
            .prepare('SELECT id FROM migration WHERE token=? AND expires>?')
            .get(token, Date.now())
        )
          throw Error('stale-precondition');
        const current = this.read();
        if (current.generation !== base.generation || current.revision !== base.revision)
          throw Error('stale-precondition');
        cancel();
        this.rotate({ ...base, revision: base.revision + 1, stamps: {}, content });
        this.db
          .prepare('UPDATE draft SET pin=?,revision=?')
          .run(next.manifest.packageHash, base.revision + 1);
      });
    return {
      before: structuredClone(base.content),
      after: structuredClone(content),
      commit,
      cancel,
    };
  }
  finishGeneration(connection: SharedConnection) {
    return this.atomic(() => {
      this.auth(connection, true);
      if (!connection.canMigrate?.()) throw Error('unauthorized');
      this.rotate(this.read());
    });
  }
  // Prove that all intervening changes to this resource are inverse pairs belonging
  // to this session. Ordinary edits and proposals always use the real live stamps.
  private inverseProof(owner: Principal, base: number, current: number) {
    const events = this.db
      .prepare('SELECT * FROM effects WHERE revision>? AND revision<=? ORDER BY revision')
      .all(base, current)
      .map((row) => ({
        ...row,
        touched: JSON.parse(String(row.keys)) as string[],
        id: String(row.id),
        inverseOf: row.inverseOf,
        actor: row.actor,
        session: row.session,
      }));
    return (key: string) => {
      if (events.length !== current - base) return false;
      const active = new Set<string>();
      for (const event of events) {
        if (!event.touched.some((changed) => changed === key || changed.startsWith(key + '/')))
          continue;
        if (event.actor !== owner.actorId || event.session !== owner.sessionId) return false;
        if (typeof event.inverseOf === 'string' && active.delete(event.inverseOf)) continue;
        active.add(event.id);
      }
      return !active.size;
    };
  }
  history(connection: SharedConnection) {
    const p = this.auth(connection);
    const top = (direction: string) =>
      this.db
        .prepare(
          'SELECT id FROM history WHERE actor=? AND session=? AND direction=? ORDER BY revision DESC LIMIT 1',
        )
        .get(p.actorId, p.sessionId, direction)?.id ?? null;
    return { undo: top('undo'), redo: top('redo') };
  }
  async previewProposal(connection: SharedConnection, raw: SharedRequest) {
    const request = structuredClone(raw),
      base = this.read(request.baseRevision),
      current = this.read();
    const write = () => this.auth(connection, true);
    const proposer = write();
    const preview = await prepareSharedEdit(
      this.verified,
      this.codecPin,
      write,
      request,
      base,
      current,
    );
    const id = randomUUID();
    this.atomic(() => {
      write();
      this.assertEditing();
      if (this.read().generation !== request.generation) throw Error('resync-required');
      this.db
        .prepare('INSERT INTO proposals VALUES(?,?,?,?,NULL,NULL)')
        .run(id, request.generation, proposer.actorId, JSON.stringify(request));
    });
    return { id, before: current.content, after: preview.snapshot.content };
  }
  adoptProposal(connection: SharedConnection, id: string, operationId: string) {
    this.auth(connection, true);
    const proposal = this.db.prepare('SELECT request FROM proposals WHERE id=?').get(id);
    if (!proposal) throw Error('resync-required');
    return this.apply(
      connection,
      { ...JSON.parse(String(proposal.request)), operationId },
      false,
      id,
    );
  }
  submit(connection: SharedConnection, request: SharedRequest) {
    return this.apply(connection, request, false);
  }
  undoRedo(connection: SharedConnection, request: HistoryRequest) {
    return this.apply(connection, request, true);
  }
  private async apply(
    connection: SharedConnection,
    raw: SharedRequest | HistoryRequest,
    history: boolean,
    proposalId?: string,
  ): Promise<Receipt> {
    let p = this.auth(connection, true);
    if (!serializable(raw) || canonical(raw).length > 1_000_000) throw Error('protocol-error');
    const req = structuredClone(raw);
    requireId(connection.namespace, req.operationId);
    const digest = fingerprint({ req, history, proposalId: proposalId ?? null }),
      id = req.operationId,
      gen = req.generation;
    const duplicate = (): Receipt | undefined => {
      const row = this.db
        .prepare('SELECT actor,digest,result,expires FROM receipts WHERE generation=? AND id=?')
        .get(gen, id);
      if (!row || (row.expires !== null && Number(row.expires) <= Date.now())) return undefined;
      if (row.actor !== p.actorId || row.digest !== digest) throw Error('protocol-error');
      return JSON.parse(String(row.result));
    };
    let charged = false;
    for (;;) {
      p = this.auth(connection, true);
      const replay = duplicate();
      if (replay) return replay;
      const current = this.read();
      if (
        req.generation !== current.generation ||
        ('artifactId' in req && req.artifactId !== this.artifactId)
      )
        throw Error('resync-required');
      this.assertEditing();
      if (!charged) {
        this.atomic(() => this.budget(gen, p));
        charged = true;
      }
      let next: SharedSnapshot<T> | undefined;
      let inverse: unknown[] = [];
      let targets: string[] = [];
      let touched: string[] = [];
      let receipt: Receipt;
      try {
        const write = () => this.auth(connection, true);
        if (history && 'direction' in req) {
          if (
            !['undo', 'redo'].includes(req.direction) ||
            this.history(connection)[req.direction] !== req.target
          )
            throw Error('undo-conflict');
          const row = this.db
            .prepare('SELECT inverse,base,revision FROM history WHERE id=?')
            .get(req.target);
          if (!row) throw Error('undo-conflict');
          try {
            const result = await evaluateShared(
              admittedCodec(this.verified, this.codecPin),
              write,
              { inverse: JSON.parse(String(row.inverse)) },
              JSON.parse(String(row.base)),
              current,
              undefined,
              this.inverseProof(p, Number(row.revision), current.revision),
            );
            next = result.snapshot;
            inverse = result.inverse;
            targets = result.targets;
            touched = result.touched;
          } catch (error) {
            if (error instanceof CodecUnavailable) throw error;
            if (error instanceof Error && error.message === 'unauthorized') throw error;
            throw Error('undo-conflict');
          }
        } else if (!history && 'baseRevision' in req) {
          const result = await prepareSharedEdit(
            this.verified,
            this.codecPin,
            write,
            req,
            this.read(req.baseRevision),
            current,
          );
          next = result.snapshot;
          inverse = result.inverse;
          targets = result.targets;
          touched = result.touched;
        } else throw Error('protocol-error');
        receipt = { status: 'accepted', operationId: id, revision: next.revision, durable: false };
      } catch (error) {
        if (error instanceof CodecUnavailable) throw error;
        const message = error instanceof Error ? error.message : 'invalid-operation';
        const known = [
          'stale-precondition',
          'unauthorized',
          'resync-required',
          'protocol-error',
          'unsupported-operation',
          'undo-conflict',
          'target-deleted',
        ] as const;
        receipt = {
          status: 'rejected',
          operationId: id,
          code: known.find((v) => v === message) ?? 'invalid-operation',
          message,
          keys: [],
        };
      }
      const result = this.atomic(() => {
        const latest = this.auth(connection, true);
        if (
          latest.actorId !== p.actorId ||
          latest.sessionId !== p.sessionId ||
          (!latest.scopes.includes('*') && !targets.every((t) => latest.scopes.includes(t)))
        )
          throw Error('unauthorized');
        const replay = duplicate();
        if (replay) return replay;
        this.assertEditing();
        const actual = this.read();
        if (actual.generation !== gen) throw Error('resync-required');
        if (actual.revision !== current.revision) return undefined;
        if (next && proposalId) {
          const adopted = this.db
            .prepare(
              'UPDATE proposals SET accepted=?,adopter=? WHERE id=? AND accepted IS NULL AND generation=?',
            )
            .run(id, p.actorId, proposalId, gen);
          if (adopted.changes !== 1) throw Error('stale-precondition');
        }
        if (next) {
          this.db
            .prepare('INSERT INTO effects VALUES(?,?,?,?,?,?)')
            .run(
              next.revision,
              id,
              p.actorId,
              p.sessionId,
              history && 'direction' in req ? req.target : null,
              JSON.stringify(touched),
            );
          if (history && 'direction' in req)
            this.db.prepare('DELETE FROM history WHERE id=?').run(req.target);
          else
            this.db
              .prepare("DELETE FROM history WHERE actor=? AND session=? AND direction='redo'")
              .run(p.actorId, p.sessionId);
          const direction =
            history && 'direction' in req && req.direction === 'undo' ? 'redo' : 'undo';
          this.db
            .prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?)')
            .run(
              id,
              p.actorId,
              p.sessionId,
              direction,
              next.revision,
              JSON.stringify(next),
              JSON.stringify(inverse),
            );
          this.db
            .prepare('INSERT INTO snapshots VALUES(?,?)')
            .run(next.revision, JSON.stringify(next));
          this.db.prepare('UPDATE draft SET revision=?').run(next.revision);
          this.db.prepare('DELETE FROM snapshots WHERE revision<=?').run(next.revision - 256);
        }
        this.db
          .prepare('INSERT INTO receipts VALUES(?,?,?,?,?,NULL)')
          .run(gen, id, p.actorId, digest, JSON.stringify(receipt));
        if (
          Number(
            this.db.prepare('SELECT count(*) AS n FROM receipts WHERE generation=?').get(gen)?.n,
          ) >= MAX_RECEIPTS
        )
          this.rotate(next ?? current);
        this.db.prepare('DELETE FROM receipts WHERE expires<=?').run(Date.now());
        return receipt;
      });
      if (result) return result;
    }
  }
  save(
    connection: SharedConnection,
    request: {
      generation: string;
      revision: number;
      contentHash: string;
      parentVersionId: string | null;
      requestId: string;
    },
  ) {
    return this.atomic(() => {
      const p = this.auth(connection, true);
      if (!UUID.test(request.requestId)) throw Error('protocol-error');
      const digest = fingerprint(request);
      const old = this.db
        .prepare('SELECT actor,digest,body FROM versions WHERE request=?')
        .get(request.requestId);
      if (old) {
        if (old.actor !== p.actorId || old.digest !== digest) throw Error('protocol-error');
        return JSON.parse(String(old.body));
      }
      this.assertEditing();
      if (!Number.isSafeInteger(request.revision) || request.revision < 0)
        throw Error('protocol-error');
      const snapshot = this.read(request.revision);
      if (
        snapshot.generation !== request.generation ||
        fingerprint(snapshot.content) !== request.contentHash
      )
        throw Error('resync-required');
      if (this.db.prepare('SELECT parent FROM draft').get()?.parent !== request.parentVersionId)
        throw Error('stale-precondition');
      const versionId = randomUUID();
      const saved = {
        generation: snapshot.generation,
        confirmedRevision: snapshot.revision,
        contentSchemaVersion: this.verified.manifest.schemaVersion,
        domain: `ext:${this.verified.manifest.id}`,
        manifest: this.verified.manifest,
        version: {
          artifactId: this.artifactId,
          versionId,
          parentVersionId: request.parentVersionId,
          // artifact-core.deserializeArtifact checks this version-envelope field.
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          createdBy: p.actorId,
          reason: null,
          content: snapshot.content,
          contentHash: request.contentHash,
        },
      };
      this.db
        .prepare('INSERT INTO versions VALUES(?,?,?,?,?)')
        .run(versionId, p.actorId, request.requestId, digest, JSON.stringify(saved));
      this.db.prepare('UPDATE draft SET parent=?').run(versionId);
      return saved;
    });
  }
}
