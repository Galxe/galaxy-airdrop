import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

export const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);

export function acquireLock(dir) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.writer-lock');
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch { /* Incomplete lock requires manual inspection. */ }
    if (owner?.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      if (!alive) {
        rmSync(lock, { recursive: true });
        return acquireLock(dir);
      }
    }
    throw new Error(`Run directory locked: ${lock}. Verify no collector is running before removing a stale lock.`);
  }
  writeFileSync(join(lock, 'owner.json'), json({ pid: process.pid, host: hostname() }));
  return () => rmSync(lock, { recursive: true, force: true });
}

export class Store {
  constructor(dir, identity) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'snapshot.sqlite');
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS log_ranges(start_block INTEGER PRIMARY KEY, end_block INTEGER NOT NULL, log_count INTEGER NOT NULL, response_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(block_hash TEXT NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL, address TEXT NOT NULL, event_name TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(block_hash,tx_hash,log_index));
        CREATE TABLE IF NOT EXISTS users(address TEXT PRIMARY KEY, first_block INTEGER NOT NULL, last_block INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS positions(address TEXT PRIMARY KEY REFERENCES users(address), staked_wei TEXT NOT NULL, pending_wei TEXT NOT NULL, unlocked_wei TEXT NOT NULL, internal_units TEXT NOT NULL, has_position INTEGER NOT NULL, address_type TEXT NOT NULL, payload TEXT NOT NULL, evidence_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS unstake_batches(address TEXT NOT NULL REFERENCES positions(address), batch_index INTEGER NOT NULL, unstake_time TEXT NOT NULL, unlock_time TEXT NOT NULL, amount_wei TEXT NOT NULL, internal_units TEXT NOT NULL, matured INTEGER NOT NULL, PRIMARY KEY(address,batch_index));
        CREATE TABLE IF NOT EXISTS errors(id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL);
      `);
      const prior = this.get('identity');
      if (prior && json(prior) !== json(identity)) throw new Error('Run directory snapshot/config identity mismatch; choose a new --out directory');
      if (!prior) this.transaction(() => {
        this.set('identity', identity);
        this.set('nextBlock', identity.fromBlock);
        this.set('startedAt', new Date().toISOString());
        this.set('status', 'collecting');
      });
    } catch (error) { this.db.close(); throw error; }
  }
  get(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, json(value)); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { action(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  commitLogs(from, to, logs, parsed, evidence) {
    if (from !== this.get('nextBlock') || to < from) throw new Error('Noncontiguous log checkpoint');
    this.transaction(() => {
      this.db.prepare('INSERT INTO log_ranges VALUES(?,?,?,?)').run(from, to, logs.length, json(evidence ?? { kind: 'eth_getLogs', logs }));
      for (const event of parsed) {
        const payload = json(event);
        const existing = this.db.prepare('SELECT payload FROM events WHERE block_hash=? AND tx_hash=? AND log_index=?').get(event.blockHash, event.txHash, event.logIndex);
        if (existing) {
          if (existing.payload !== payload) throw new Error('Conflicting duplicate staking log');
          throw new Error('Duplicate staking log');
        }
        this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(event.blockHash, event.txHash, event.logIndex, event.block, event.address, event.name, payload);
        this.db.prepare('INSERT INTO users VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET first_block=MIN(first_block,excluded.first_block),last_block=MAX(last_block,excluded.last_block)').run(event.address, event.block, event.block);
      }
      this.set('nextBlock', to + 1);
    });
  }
  pendingUsers(limit) { return this.db.prepare('SELECT address FROM users WHERE address NOT IN (SELECT address FROM positions) ORDER BY address LIMIT ?').all(limit).map(row => row.address); }
  commitPositions(rows) {
    this.transaction(() => {
      for (const { row, evidence } of rows) {
        this.db.prepare('INSERT INTO positions VALUES(?,?,?,?,?,?,?,?,?)').run(row.address, row.stakedWei, row.pendingWei, row.unlockedWei, row.internalUnits, Number(row.hasPosition), row.type, json(row), json(evidence));
        for (const batch of row.batches) this.db.prepare('INSERT INTO unstake_batches VALUES(?,?,?,?,?,?,?)').run(row.address, batch.index, batch.unstakeTime, batch.unlockTime, batch.amountWei, batch.internalUnits, Number(batch.matured));
      }
    });
  }
  *rows() { for (const record of this.db.prepare('SELECT payload FROM positions ORDER BY address').iterate()) yield JSON.parse(record.payload); }
  count(table) {
    if (!['users', 'positions', 'events', 'log_ranges'].includes(table)) throw new Error('Unknown count table');
    return this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  }
  verifyCoverage() {
    let next = this.get('identity').fromBlock;
    for (const row of this.db.prepare('SELECT * FROM log_ranges ORDER BY start_block').iterate()) {
      if (row.start_block !== next || row.end_block < row.start_block) throw new Error('Log coverage gap or overlap');
      next = row.end_block + 1;
    }
    if (next !== this.get('identity').block + 1 || next !== this.get('nextBlock')) throw new Error('Log scan incomplete');
    if (this.count('users') !== this.count('positions')) throw new Error('User state queries incomplete');
    if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity check failed');
  }
  recordError(stage, message) { this.db.prepare('INSERT INTO errors(recorded_at,stage,message) VALUES(?,?,?)').run(new Date().toISOString(), stage, message); }
  close() {
    if (this.closed) return;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
    finally { this.db.close(); this.closed = true; }
  }
}
