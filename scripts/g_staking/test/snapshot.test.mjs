import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { keccak256 } from 'ethers';
import { Rpc, RpcError, hex } from '../lib/rpc.mjs';
import { Store, acquireLock, json } from '../lib/store.mjs';
import { ABI, CONTRACT, parseLog, buildPosition, collectLogs, collectPositions, reconcile } from '../lib/snapshot.mjs';
import { SAFE, classify } from '../lib/classify.mjs';
import { writeExports } from '../lib/export.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const HASH = '0x' + 'ab'.repeat(32);
const config = { multiplier: '1', timestamp: '1000', lockTimePeriod: '100', paused: false, unStakeLimit: '10', custodyWei: '150' };
const identity = { block: 42, blockHash: HASH, fromBlock: 0 };
const emptyRegistry = { proxyHashes: new Set(), implementationHashes: new Map() };
function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'gravity-staking-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function openStore(t, overrides = {}) { const dir = directory(t); const store = new Store(dir, { ...identity, ...overrides }); t.after(() => store.close()); return { store, dir }; }
function log(name = 'TokenStaked', user = A, block = 10, index = 0) {
  const encoded = ABI.encodeEventLog(ABI.getEvent(name), [user, name === 'TokenStaked' ? 150n : [800n, 30n]]);
  return { address: CONTRACT.address, blockNumber: hex(block), blockHash: HASH, transactionHash: '0x' + (index + 1).toString(16).padStart(64, '0'), logIndex: hex(index), removed: false, ...encoded };
}
function position(user = A, amount = 150n) {
  return { ...buildPosition(user, { staked: amount, rawStaked: amount, batches: [] }, [], config), type: 'EOA', codeHash: keccak256('0x') };
}
function recordUser(store, user = A) { const l = log('TokenStaked', user); store.commitLogs(0, 42, [l], [parseLog(l, 0, 42)]); }
const response = result => ({ ok: true, json: async () => result });

test('multiplier conversion is applied once; exact unlock boundary, dust and pause are retained', () => {
  const cfg = { ...config, multiplier: '60', timestamp: '1010', lockTimePeriod: '10', paused: true };
  const row = buildPosition(A, { staked: 2n, rawStaked: 121n, batches: [{ unStakeTime: 1000n, amount: 1n }, { unStakeTime: 1001n, amount: 0n }] }, [{ unStakeTime: 1000n, amount: 61n }, { unStakeTime: 1001n, amount: 59n }], cfg);
  assert.equal(row.stakedWei, '2');
  assert.equal(row.unlockedWei, '1');
  assert.equal(row.pendingWei, '0');
  assert.equal(row.internalUnits, '241');
  assert.equal(row.batches[0].matured, true);
  assert.equal(row.batches[1].matured, false);
  assert.equal(row.batches[1].roundingRemainderUnits, '59');
  assert.equal(row.paused, true);
});

test('getter inconsistencies and future unstake timestamps fail instead of changing balances', () => {
  assert.throws(() => buildPosition(A, { staked: 1n, rawStaked: 2n, batches: [] }, [], config), /mismatch/);
  assert.throws(() => buildPosition(A, { staked: 0n, rawStaked: 0n, batches: [{ unStakeTime: 1001n, amount: 1n }] }, [{ unStakeTime: 1001n, amount: 1n }], config), /mismatch/);
  assert.equal(buildPosition(A, { staked: 0n, rawStaked: 0n, batches: [] }, [], config).hasPosition, false);
});

test('all four events discover userAddress, including a contract caller', () => {
  for (const name of ['TokenStaked', 'TokenUnStaked', 'TokenRevokeUnStaked', 'TokenWithdraw']) {
    const event = log(name); event.from = B;
    assert.equal(parseLog(event, 0, 42).address, A);
  }
  assert.throws(() => parseLog(log(), 11, 42), /out-of-range/);
  assert.throws(() => parseLog({ ...log(), data: log().data + '00' }, 0, 42), /encoding/);
});

test('SQLite log checkpoint and discovered users roll back together on duplicate/conflict', t => {
  const { store } = openStore(t);
  const l = log(), event = parseLog(l, 0, 42);
  assert.throws(() => store.commitLogs(0, 42, [l, l], [event, { ...event, amount: '999' }]), /Conflicting/);
  assert.equal(store.get('nextBlock'), 0);
  assert.equal(store.count('users'), 0);
  recordUser(store);
  assert.equal(store.get('nextBlock'), 43);
  assert.throws(() => store.commitLogs(0, 42, [], []), /Noncontiguous/);
});

test('SQLite resumes committed work and rejects another snapshot identity', t => {
  const { store, dir } = openStore(t);
  recordUser(store); store.close();
  const resumed = new Store(dir, identity);
  assert.equal(resumed.get('nextBlock'), 43);
  assert.deepEqual(resumed.pendingUsers(10), [A]);
  resumed.close();
  assert.throws(() => new Store(dir, { ...identity, blockHash: '0x' + 'cd'.repeat(32) }), /identity mismatch/);
});

test('run directory allows one live writer', t => {
  const dir = directory(t), release = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /locked/);
  release(); acquireLock(dir)();
});

test('a reader blocking WAL checkpoint prevents sealing until the database can stand alone', t => {
  const { store, dir } = openStore(t);
  store.set('checkpointMarker', 'before');
  store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  const reader = new DatabaseSync(join(dir, 'snapshot.sqlite'));
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT value FROM meta WHERE key=?').get('checkpointMarker');
    store.set('checkpointMarker', 'after');
    assert.throws(() => store.close(), /WAL checkpoint blocked/);
    assert.equal(store.closed, true);
  } finally { reader.close(); }
  const resumed = new Store(dir, identity);
  try { assert.equal(resumed.get('checkpointMarker'), 'after'); } finally { resumed.close(); }
  copyFileSync(join(dir, 'snapshot.sqlite'), join(dir, 'archive.sqlite'));
  const archive = new DatabaseSync(join(dir, 'archive.sqlite'));
  try { assert.equal(JSON.parse(archive.prepare('SELECT value FROM meta WHERE key=?').get('checkpointMarker').value), 'after'); }
  finally { archive.close(); }
});

test('RPC batch matches IDs despite response order and rejects malformed/failed members', async () => {
  let mode = 'reversed';
  const rpc = new Rpc(['https://example.invalid'], { delay: 0, retries: 0, fetcher: async (_, init) => {
    const requests = JSON.parse(init.body);
    const responses = requests.map(request => ({ id: request.id, result: request.params[0] }));
    if (mode === 'duplicate') responses[1].id = responses[0].id;
    if (mode === 'error') responses[1] = { id: responses[1].id, error: { code: -32000, message: 'historical state unavailable' } };
    return response(responses.reverse());
  } });
  const calls = ['a', 'b'].map(value => ({ method: 'example', params: [value] }));
  assert.deepEqual(await rpc.batch(calls), ['a', 'b']);
  mode = 'duplicate'; await assert.rejects(rpc.batch(calls), /Duplicate/);
  mode = 'error'; await assert.rejects(rpc.batch(calls), /historical state unavailable/);
});

test('failover is rejected before state reads if the chain/block does not match', async () => {
  const received = [];
  const rpc = new Rpc(['https://first.invalid', 'https://second.invalid'], { delay: 0, retries: 0, fetcher: async (url, init) => {
    if (url.includes('first')) throw new Error('offline');
    const request = JSON.parse(init.body); received.push(request.method);
    return response({ id: request.id, result: request.method === 'eth_chainId' ? '0x1' : { hash: HASH } });
  } });
  rpc.identity = { block: 42, blockHash: HASH };
  await assert.rejects(rpc.call('eth_getBalance', [A, '0x2a']), /identity mismatch/);
  assert(!received.includes('eth_getBalance'));
});

test('initial pinning verifies the chain on the endpoint that supplied the block', async () => {
  let fallbackChain = '0x1';
  const rpc = new Rpc(['https://primary.invalid', 'https://fallback.invalid'], { delay: 0, retries: 0, fetcher: async (url, init) => {
    const request = JSON.parse(init.body), fallback = url.includes('fallback');
    if (!fallback && request.method === 'eth_getBlockByNumber') throw new Error('timeout');
    const result = request.method === 'eth_chainId' ? (fallback ? fallbackChain : '0x659') : { number: '0x2a', hash: HASH };
    return response({ id: request.id, result });
  } });
  await assert.rejects(rpc.pin(42), /chain ID 1625/);
  assert.equal(rpc.identity, undefined);
  rpc.active = 0; fallbackChain = '0x659';
  assert.equal((await rpc.pin(42)).hash, HASH);
});

test('transport timeouts shrink log ranges and complete the scan', async t => {
  const { store } = openStore(t, { block: 2 }), ranges = [];
  const rpc = new Rpc(['https://example.invalid'], { delay: 0, retries: 0, fetcher: async (_, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_getBlockByNumber') return response({ id: request.id, result: { hash: HASH } });
    assert.equal(request.method, 'eth_getLogs');
    const range = request.params[0]; ranges.push([range.fromBlock, range.toBlock]);
    if (range.fromBlock !== range.toBlock) throw new Error('provider timeout');
    return response({ id: request.id, result: range.fromBlock === '0x1' ? [log('TokenStaked', A, 1)] : [] });
  } });
  rpc.identity = { block: 2, blockHash: HASH };
  await collectLogs(rpc, store, { block: 2, chunkSize: 3, logLimit: 10000 });
  assert.deepEqual(ranges[0], ['0x0', '0x2']);
  assert(ranges.some(([from, to]) => from === '0x1' && to === '0x1'));
  assert.equal(store.get('nextBlock'), 3);
  assert.equal(store.count('users'), 1);
});

test('a changed canonical block stops a run', async () => {
  const rpc = new Rpc(['https://example.invalid'], { delay: 0, retries: 0, fetcher: async (_, init) => response({ id: JSON.parse(init.body).id, result: { hash: '0x' + 'cd'.repeat(32) } }) });
  rpc.identity = { block: 42, blockHash: HASH };
  await assert.rejects(rpc.assertCanonical(), /hash changed/);
});

test('log splitting, single-block receipt fallback, and resume preserve coverage', async t => {
  const { store } = openStore(t, { block: 2 });
  const l = log('TokenStaked', A, 1);
  let calls = 0;
  const rpc = {
    assertCanonical: async () => {},
    call: async (method, params) => {
      calls++;
      if (method === 'eth_getBlockByNumber') return { number: '0x1', hash: HASH, transactions: [l.transactionHash] };
      const [filter] = params;
      if (filter.fromBlock !== filter.toBlock) throw new RpcError({ code: -32000, message: 'block range too large' });
      return filter.fromBlock === '0x1' ? [l] : [];
    },
    batch: async () => [{ blockHash: HASH, blockNumber: '0x1', transactionHash: l.transactionHash, logs: [l] }],
  };
  await collectLogs(rpc, store, { block: 2, chunkSize: 3, logLimit: 1 });
  assert.equal(store.count('users'), 1);
  assert.equal(store.get('nextBlock'), 3);
  const before = calls;
  await collectLogs(rpc, store, { block: 2, chunkSize: 3, logLimit: 1 });
  assert.equal(calls, before);
});

test('failed user reads never commit zero stakes or EOA classifications', async t => {
  const { store } = openStore(t); recordUser(store);
  const rpc = { assertCanonical: async () => {}, batch: async () => { throw new Error('archive read failed'); } };
  await assert.rejects(collectPositions(rpc, store, { block: 42, config, registryLoader: async () => emptyRegistry }), /archive read failed/);
  assert.equal(store.count('positions'), 0);
  assert.deepEqual(store.pendingUsers(1), [A]);
});

test('EOA, delegated EOA and reserved addresses are distinguished', async () => {
  const rpc = { call: async () => { throw new Error('Unexpected RPC'); } };
  assert.equal((await classify(rpc, A, '0x', 42, emptyRegistry)).type, 'EOA');
  assert.equal((await classify(rpc, A, '0xef0100' + B.slice(2), 42, emptyRegistry)).type, 'EOA_DELEGATED');
  assert.equal((await classify(rpc, '0x0000000000000000000000000000000000000064', '0x', 42, emptyRegistry)).type, 'SPECIAL');
});

test('Safe owners and threshold require recognized proxy AND implementation bytecode', async () => {
  const proxyCode = '0x6001', implementationCode = '0x6002';
  const registry = { proxyHashes: new Set([keccak256(proxyCode)]), implementationHashes: new Map([[keccak256(implementationCode), '1.4.1']]) };
  const rpc = { call: async (method, params) => {
    if (method === 'eth_getCode') return implementationCode;
    if (method === 'eth_getStorageAt') return '0x' + B.slice(2).padStart(64, '0');
    const call = SAFE.parseTransaction({ data: params[0].data });
    const result = { masterCopy: B, getOwners: [A, B], getThreshold: 2n, VERSION: '1.4.1' }[call.name];
    return SAFE.encodeFunctionResult(call.name, [result]);
  } };
  const safe = await classify(rpc, A, proxyCode, 42, registry);
  assert.equal(safe.type, 'SAFE'); assert.equal(safe.safe.threshold, 2); assert.equal(safe.safe.requiresMultipleSigners, true);
  assert.equal((await classify(rpc, A, '0x6003', 42, registry)).type, 'CONTRACT');
});

test('custody reconciliation keeps uint256 precision and marks every explicit sample partial', t => {
  const { store } = openStore(t); recordUser(store);
  const amount = 2n ** 200n + 123n;
  store.commitPositions([{ row: position(A, amount), evidence: {} }]);
  const cfg = { ...config, custodyWei: amount.toString() };
  assert.equal(reconcile(store, cfg, { fromBlock: 0, limitUsers: 0 }).status, 'reconciled');
  assert.equal(reconcile(store, cfg, { fromBlock: 1, limitUsers: 0 }).status, 'partial');
  assert.equal(reconcile(store, cfg, { fromBlock: 0, limitUsers: 1 }).status, 'partial');
  assert.equal(reconcile(store, { ...cfg, custodyWei: (amount + 1n).toString() }, { fromBlock: 0, limitUsers: 0 }).status, 'custody_surplus');
  assert.equal(reconcile(store, { ...cfg, custodyWei: (amount - 1n).toString() }, { fromBlock: 0, limitUsers: 0 }).status, 'custody_deficit');
});

test('exports are reproducible, retain zero-position users and exact decimal strings', async t => {
  const { store, dir } = openStore(t); recordUser(store);
  store.commitPositions([{ row: position(A, 0n), evidence: {} }]);
  const report = { status: 'partial', block: 42, config };
  await writeExports(store, dir, report);
  const original = readFileSync(join(dir, 'exports/stakers.csv'), 'utf8');
  assert(original.includes(A)); assert(original.includes('"0"'));
  assert.equal(readFileSync(join(dir, 'exports/stakers.active.csv'), 'utf8').trim().split('\n').length, 1);
  await writeExports(store, dir, report);
  assert.equal(readFileSync(join(dir, 'exports/stakers.csv'), 'utf8'), original);
});

test('CSV neutralizes contract-supplied formulas while JSONL preserves original evidence', async t => {
  const versions = ['=HYPERLINK("https://example.invalid")', '+1+1', '-1+1', '@SUM(1)', '\t=1+1', '\r=1+1', ' =1+1'];
  const dir = directory(t);
  const store = { *rows() { for (const version of versions) yield { ...position(), type: 'CONTRACT', safe: { verified: false, version, threshold: 1, owners: [A] } }; } };
  await writeExports(store, dir, { status: 'reconciled', block: 42, config });
  const csv = readFileSync(join(dir, 'exports/stakers.csv'), 'utf8');
  for (const version of versions) assert(csv.includes(`"'${version.replaceAll('"', '""')}"`));
  const rows = readFileSync(join(dir, 'exports/stakers.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.safe.version), versions);
});

test('CLI integrates full history, raw batches, custody, deterministic resume and failure recovery', async t => {
  const dir = directory(t);
  const runtime = readFileSync(new URL('./fixtures/staking-runtime.hex', import.meta.url), 'utf8').trim();
  assert.equal(keccak256(runtime), CONTRACT.runtimeCodeHash);
  const events = [log(), log('TokenStaked', B, 11, 1), log('TokenWithdraw', B, 12, 2)];
  let logCalls = 0, failState = true;
  const handler = request => {
    const { method, params, id } = request;
    let result;
    if (method === 'eth_chainId') result = '0x659';
    else if (method === 'eth_getBlockByNumber') result = { number: '0x2a', hash: HASH, stateRoot: HASH, timestamp: '0x3e8', transactions: [] };
    else if (method === 'eth_getCode') result = params[0] === CONTRACT.address ? runtime : '0x';
    else if (method === 'eth_getBalance') result = '0x96';
    else if (method === 'eth_getLogs') { logCalls++; result = events; }
    else if (method === 'eth_call') {
      const call = ABI.parseTransaction({ data: params[0].data });
      if (failState && call.name === 'getStakeAmount') return { id, error: { code: -32000, message: 'archive read failed' } };
      const active = call.args.length > 0 && typeof call.args[0] === 'string' && call.args[0].toLowerCase() === A;
      const data = {
        allowedToken: ['0x' + '00'.repeat(20)], multiplier: [1n], lockTimePeriod: [100n], paused: [false], unStakeLimit: [10n],
        getStakeAmount: [active ? 100n : 0n], balances: [active ? 100n : 0n],
        getUnStakeInfo: [active ? [[950n, 20n], [800n, 30n]] : []],
        unStakeInfoMap: call.args.length > 1 && Number(call.args[1]) === 0 ? [950n, 20n] : [800n, 30n],
      }[call.name];
      result = ABI.encodeFunctionResult(call.name, data);
    } else throw new Error(`Unexpected method ${method}`);
    return { jsonrpc: '2.0', id, result };
  };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    try { const input = JSON.parse(body); const result = Array.isArray(input) ? input.map(handler).reverse() : handler(input); res.setHeader('content-type', 'application/json'); res.end(json(result)); }
    catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const run = async extra => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../gravity-staking.mjs', import.meta.url)), '--block', '42', '--out', dir, '--rpc', endpoint, '--fallback-rpc', endpoint, '--delay-ms', '0', ...(extra ?? [])]);
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const [code] = await once(child, 'close'); return { code, stdout, stderr };
  };
  const failed = await run(); assert.equal(failed.code, 1, failed.stderr); assert(!existsSync(join(dir, 'manifest.json')));
  assert.equal(logCalls, 1, failed.stderr);
  failState = false;
  const succeeded = await run(); assert.equal(succeeded.code, 0, succeeded.stderr);
  assert.equal(logCalls, 1, 'committed log scan is resumed after state query failure');
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.status, 'reconciled'); assert.equal(report.summary.historicalUsers, 2); assert.equal(report.summary.activeUsers, 1);
  assert.equal(report.summary.pendingWei, '20'); assert.equal(report.summary.unlockedWei, '30');
  assert.equal(report.reconciliation.differenceInternalUnits, '0');
  const csvBefore = readFileSync(join(dir, 'exports/stakers.csv'), 'utf8');
  const again = await run(); assert.equal(again.code, 0, again.stderr); assert.equal(logCalls, 1);
  assert.equal(readFileSync(join(dir, 'exports/stakers.csv'), 'utf8'), csvBefore);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.ethereumRecipientsAssigned, false); assert(manifest.files['snapshot.sqlite']);
  const wrongIdentity = await run(['--limit-users', '1']); assert.equal(wrongIdentity.code, 1); assert.match(wrongIdentity.stderr, /identity mismatch/);
});
