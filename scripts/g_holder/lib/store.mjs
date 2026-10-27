import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { json, bytes, prefixed } from './data.mjs';

export class Store {
  constructor(dir, identity) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'snapshot.sqlite'));
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, source TEXT NOT NULL, checkpoint TEXT NOT NULL, sha256 TEXT NOT NULL, raw_gzip BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts(trie_key BLOB PRIMARY KEY CHECK(length(trie_key)=32), address BLOB UNIQUE CHECK(address IS NULL OR length(address)=20), nonce TEXT NOT NULL, balance_wei TEXT NOT NULL, storage_root BLOB NOT NULL, code_hash BLOB NOT NULL, account_rlp BLOB NOT NULL, chunk_id INTEGER NOT NULL REFERENCES chunks(id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS trie_nodes(key BLOB PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS codes(code_hash BLOB PRIMARY KEY, address BLOB NOT NULL, code TEXT NOT NULL, kind TEXT NOT NULL, delegation TEXT) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS classifications(address BLOB PRIMARY KEY, payload TEXT NOT NULL, evidence TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS errors(id INTEGER PRIMARY KEY, time TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL);
      `);
      const prior = this.get('identity');
      if (prior && json(prior) !== json(identity)) throw new Error('Snapshot/source/config identity mismatch; use a new run directory');
      if (!prior) this.atomic(() => {
        this.set('identity', identity); this.set('startedAt', new Date().toISOString());
        this.set('accountCount', 0); this.set('sourceComplete', false); this.set('cursor', '0x'); this.set('fileOffset', 0);
      });
    } catch (error) { this.db.close(); throw error; }
    this.insertAccount = this.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)');
  }
  get(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, json(value)); }
  atomic(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { action(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async atomicAsync(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { await action(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  commitChunk(accounts, raw, checkpoint) {
    if (this.get('sourceComplete')) throw new Error('Source already sealed');
    const compressed = gzipSync(raw), digest = createHash('sha256').update(raw).digest('hex');
    this.atomic(() => {
      const chunk = this.db.prepare('INSERT INTO chunks(source,checkpoint,sha256,raw_gzip) VALUES(?,?,?,?)').run(this.get('identity').source.mode, json(checkpoint), digest, compressed).lastInsertRowid;
      for (const row of accounts) {
        // Never discard duplicate leaves: both identical and conflicting duplicates fail.
        this.insertAccount.run(bytes(row.trieKey), row.address === null ? null : bytes(row.address), row.nonce, row.balanceWei, bytes(row.storageRoot), bytes(row.codeHash), bytes(row.accountRlp), chunk);
      }
      this.set('accountCount', this.get('accountCount') + accounts.length);
      for (const [key, value] of Object.entries(checkpoint)) this.set(key, value);
    });
  }
  pageAfter(key, size) {
    return key ? this.db.prepare('SELECT trie_key,account_rlp FROM accounts WHERE trie_key>? ORDER BY trie_key LIMIT ?').all(bytes(key), size)
      : this.db.prepare('SELECT trie_key,account_rlp FROM accounts ORDER BY trie_key LIMIT ?').all(size);
  }
  *holders() {
    for (const row of this.db.prepare("SELECT a.*,c.kind,c.delegation,s.payload AS classification FROM accounts a LEFT JOIN codes c ON a.code_hash=c.code_hash LEFT JOIN classifications s ON a.address=s.address WHERE a.balance_wei!='0' ORDER BY a.address").iterate()) {
      yield { address: row.address === null ? null : prefixed(row.address), balanceWei: row.balance_wei, nonce: row.nonce, codeHash: prefixed(row.code_hash), codeKind: row.kind, delegation: row.delegation, classification: row.classification ? JSON.parse(row.classification) : null };
    }
  }
  finishImport() {
    if (!this.get('sourceComplete')) throw new Error('Account source incomplete');
    this.db.exec("CREATE INDEX IF NOT EXISTS positive_codes ON accounts(code_hash,address) WHERE balance_wei!='0'");
  }
  checkIntegrity() {
    if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity check failed');
  }
  close() {
    if (this.closed) return;
    try {
      const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (result.busy !== 0 || result.log !== result.checkpointed) throw new Error('SQLite WAL checkpoint blocked; close other database connections and rerun before archiving');
    } finally { this.db.close(); this.closed = true; }
  }
}

// @ethereumjs/trie passes unprefixed hexadecimal keys and byte values.
// Keep trie nodes on disk; a verification batch and its root checkpoint share a transaction.
export class TrieDB {
  constructor(store) {
    this.store = store;
    this.read = store.db.prepare('SELECT value FROM trie_nodes WHERE key=?');
    this.write = store.db.prepare('INSERT INTO trie_nodes VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.remove = store.db.prepare('DELETE FROM trie_nodes WHERE key=?');
  }
  key(key) {
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/i.test(key)) throw new Error('Unexpected trie database key encoding');
    return Buffer.from(key, 'hex');
  }
  async get(key) { return this.read.get(this.key(key))?.value; }
  async put(key, value) {
    if (!(value instanceof Uint8Array)) throw new Error('Unexpected trie value encoding');
    this.write.run(this.key(key), value);
  }
  async del(key) { this.remove.run(this.key(key)); }
  async batch(operations) {
    for (const op of operations) {
      if (op.type === 'put') await this.put(op.key, op.value);
      else if (op.type === 'del') await this.del(op.key);
      else throw new Error('Unknown trie database operation');
    }
  }
  shallowCopy() { return new TrieDB(this.store); }
  async open() {}
}
