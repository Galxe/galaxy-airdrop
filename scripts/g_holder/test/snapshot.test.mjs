import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Trie } from '@ethereumjs/trie';
import { keccak256, encodeRlp, Interface } from 'ethers';
import { parse, json, hash, uint, bytes, prefixed, EMPTY_CODE, EMPTY_ROOT, normalizeAccount, decodeCursor, validatePage } from '../lib/data.mjs';
import { Store } from '../lib/store.mjs';
import { verifyState } from '../lib/verify.mjs';
import { inspectFile, collectFile, lines, collectRpc } from '../lib/sources.mjs';
import { Rpc } from '../lib/rpc.mjs';
import { classifyHolders, summarize } from '../lib/holders.mjs';
import { writeExports } from '../lib/export.mjs';
import { bridgeReconciliation, G_TOKEN, BRIDGE } from '../lib/bridge.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0xb9ad636435ef1bcd10c7021d1767813d179ca3bf';
const C = '0x3333333333333333333333333333333333333333';
const D = '0x4444444444444444444444444444444444444444';
const HASH = '0x' + 'ab'.repeat(32), ETH_HASH = '0x' + 'cd'.repeat(32);
const code = '0x60016000', delegated = '0xef0100' + A.slice(2);
const fixture = () => [
  normalizeAccount({ address: A, nonce: '18446744073709551615', balance: (2n ** 120n + 100n).toString(), root: EMPTY_ROOT, codeHash: EMPTY_CODE }),
  normalizeAccount({ address: B, nonce: 1, balance: '25', root: EMPTY_ROOT, codeHash: keccak256(code) }),
  normalizeAccount({ address: C, nonce: 3, balance: '0', root: EMPTY_ROOT, codeHash: EMPTY_CODE }),
  normalizeAccount({ address: D, nonce: 0, balance: '40', root: EMPTY_ROOT, codeHash: keccak256(delegated) }),
];
async function referenceRoot(rows) {
  const trie = new Trie({ useKeyHashing: true });
  for (const row of rows) await trie.put(bytes(row.address), bytes(row.accountRlp));
  return prefixed(trie.root());
}
function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'gravity-g-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function storeFor(t, stateRoot, overrides = {}) {
  const dir = directory(t), identity = { chainId: 1625, block: 42, blockHash: HASH, stateRoot, source: { mode: 'state-file' }, ...overrides };
  const store = new Store(dir, identity); t.after(() => store.close()); return { store, dir, identity };
}
function putAll(store, rows) { store.commitChunk(rows, json(rows), { sourceComplete: true }); store.finishImport(); }
function dumpRow(row) { return { address: row.address, key: row.trieKey, nonce: row.nonce, balance: row.balanceWei, root: row.storageRoot, codeHash: row.codeHash }; }
const fetchResponse = text => ({ ok: true, text: async () => text });

test('lossless RPC JSON preserves uint64 nonce and rejects unsafe JS numeric inputs', () => {
  const parsed = parse('{"nonce":18446744073709551615,"balance":"1"}');
  assert.equal(parsed.nonce, '18446744073709551615');
  assert.throws(() => uint(18446744073709551615), /Unsafe/);
  assert.throws(() => uint('18446744073709551616', 64), /overflow/);
  assert.throws(() => uint(''), /Invalid/);
  assert.throws(() => parse('{"nonce":1,"nonce":2}'));
});

test('account RLP uses minimal integers and verifies address preimages', () => {
  const row = normalizeAccount({ address: A, nonce: '0', balance: '0', root: EMPTY_ROOT, codeHash: EMPTY_CODE });
  assert.equal(row.accountRlp, encodeRlp(['0x', '0x', EMPTY_ROOT, EMPTY_CODE]));
  assert.throws(() => normalizeAccount({ ...row, trieKey: keccak256(B) }), /preimage/);
  assert.throws(() => normalizeAccount({ ...row, accountRlp: '0x00' }), /RLP mismatch/);
});

test('Nitro Base64 cursors, missing-address leaves and cursor loops are handled explicitly', () => {
  const rows = fixture().sort((a, b) => a.trieKey.localeCompare(b.trieKey));
  const next = Buffer.from(rows[1].trieKey.slice(2), 'hex').toString('base64');
  assert.equal(decodeCursor(next), rows[1].trieKey);
  const page = { root: HASH.slice(2), accounts: { [rows[0].address]: dumpRow(rows[0]) }, next };
  assert.equal(validatePage(page, '0x', HASH, 1).accounts.length, 1);
  assert.throws(() => validatePage({ ...page, next: Buffer.from(rows[0].trieKey.slice(2), 'hex').toString('base64') }, '0x', HASH, 1), /advance/);
  assert.throws(() => validatePage({ ...page, accounts: {} }, '0x', HASH, 1), /advance/);
  assert.throws(() => decodeCursor('not-a-cursor'), /Base64/);
  const missing = dumpRow(rows[0]); missing.address = null;
  assert.equal(validatePage({ root: HASH, accounts: { [`pre(${missing.key})`]: missing } }, '0x', HASH, 1).accounts[0].address, null);
});

test('single-leaf root agrees with independently encoded hex-prefix MPT leaf', async t => {
  const row = fixture()[0];
  const expected = keccak256(encodeRlp(['0x20' + row.trieKey.slice(2), row.accountRlp]));
  const { store } = storeFor(t, expected); putAll(store, [row]);
  assert.equal(await verifyState(store, expected), expected);
});

test('disk trie matches secure-key reference trie and includes zero-balance leaves', async t => {
  const rows = fixture(), root = await referenceRoot(rows), { store } = storeFor(t, root);
  putAll(store, rows.reverse());
  assert.equal(await verifyState(store, root, { batchSize: 2 }), root);
  assert.equal(store.get('trieProcessed'), 4);
  assert(store.db.prepare('SELECT COUNT(*) AS n FROM trie_nodes').get().n > 0);
});

test('dropping a zero-balance account or prematurely ending enumeration cannot pass', async t => {
  const rows = fixture(), root = await referenceRoot(rows), { store } = storeFor(t, root);
  putAll(store, rows.filter(row => row.balanceWei !== '0'));
  await assert.rejects(verifyState(store, root), /stateRoot mismatch/);
  assert.equal(store.get('verifiedRoot'), undefined);
  await assert.rejects(writeExports(store, directory(t), {}), /required/);
});

test('missing positive preimages block completion; missing zero-balance preimages remain auditable', async t => {
  const rows = fixture(), root = await referenceRoot(rows);
  const good = storeFor(t, root).store;
  putAll(good, rows.map(row => row.address === C ? { ...row, address: null } : row));
  await verifyState(good, root);
  const bad = storeFor(t, root).store;
  putAll(bad, rows.map(row => row.address === A ? { ...row, address: null } : row));
  await assert.rejects(verifyState(bad, root), /positive-balance accounts/);
});

test('duplicate accounts roll back source rows and cursor atomically', t => {
  const { store } = storeFor(t, HASH), row = fixture()[0];
  assert.throws(() => store.commitChunk([row, row], json([row, row]), { cursor: row.trieKey }), /UNIQUE/);
  assert.equal(store.get('accountCount'), 0); assert.equal(store.get('cursor'), '0x');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 0);
});

test('a reader blocking WAL checkpoint prevents sealing until the database can stand alone', t => {
  const { store, dir, identity } = storeFor(t, HASH);
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

test('interrupted trie batch rolls back nodes AND root checkpoint, then resumes', async t => {
  const rows = fixture(), root = await referenceRoot(rows), { store } = storeFor(t, root);
  putAll(store, rows);
  await assert.rejects(verifyState(store, root, { batchSize: 2, afterLeaf: n => { if (n === 3) throw new Error('simulated crash'); } }), /simulated crash/);
  assert.equal(store.get('trieProcessed'), 2);
  assert.equal(await verifyState(store, root, { batchSize: 2 }), root);
});

test('state JSONL byte checkpoints support CRLF, no final newline and restart', async t => {
  const rows = fixture(), root = await referenceRoot(rows), { store, dir, identity } = storeFor(t, root);
  const path = join(dir, 'state.jsonl');
  writeFileSync(path, [json({ root }), ...rows.map(row => json(dumpRow(row)))].join('\r\n'));
  const info = await inspectFile(path, identity);
  let committed = false;
  await assert.rejects(collectFile(store, path, info, { pageSize: 2, progress: () => { committed = true; throw new Error('stop'); } }), /stop/);
  assert(committed); assert.equal(store.get('accountCount'), 2);
  await collectFile(store, path, info, { pageSize: 2 });
  assert.equal(store.get('accountCount'), 4); assert.equal(store.get('sourceComplete'), true);
  store.finishImport(); await verifyState(store, root);
  const read = []; for await (const line of lines(path)) read.push(line);
  assert.equal(read.at(-1).end, readFileSync(path).length);
});

test('RPC ingestion uses fixed block hash, includes unknown preimages and resumes from next key', async t => {
  const rows = fixture().sort((a, b) => a.trieKey.localeCompare(b.trieKey));
  const root = await referenceRoot(rows), { store, identity } = storeFor(t, root, { source: { mode: 'rpc-state' } });
  const starts = [];
  const rpc = { assertCanonical: async () => {}, call: async (method, params) => {
    assert.equal(method, 'debug_accountRange'); assert.deepEqual(params[0], { blockHash: HASH, requireCanonical: true });
    assert.deepEqual(params.slice(3), [true, true, true]); starts.push(params[1]);
    const remaining = rows.filter(row => params[1] === '0x' || row.trieKey >= params[1]);
    const selected = remaining.slice(0, 2);
    return { root, accounts: Object.fromEntries(selected.map(row => [row.address, dumpRow(row)])), ...(remaining.length > 2 ? { next: bytes(remaining[2].trieKey).toString('base64') } : {}) };
  } };
  await assert.rejects(collectRpc(store, rpc, identity, { pageSize: 2, progress: () => { throw new Error('stop'); } }), /stop/);
  assert.equal(store.get('accountCount'), 2);
  await collectRpc(store, rpc, identity, { pageSize: 2 });
  assert.deepEqual(starts, ['0x', rows[2].trieKey]);
  await verifyState(store, root);
});

test('RPC response IDs are correlated and nonces parse losslessly; failures never become values', async () => {
  let fail = false;
  const rpc = new Rpc(['https://invalid.example'], { delay: 0, retries: 0, fetcher: async (_, init) => {
    const requests = JSON.parse(init.body);
    if (fail) return fetchResponse(json(requests.map(request => ({ id: request.id, error: { code: -32000, message: 'archive state unavailable' } }))));
    return fetchResponse('[' + requests.reverse().map(request => `{"id":${request.id},"result":{"nonce":18446744073709551615}}`).join(',') + ']');
  } });
  const calls = [A, B].map(address => ({ method: 'test', params: [address] }));
  assert.equal((await rpc.batch(calls))[0].nonce, '18446744073709551615');
  fail = true; await assert.rejects(rpc.batch(calls), /archive state unavailable/);
});

test('code classification uses verified hashes, keeps staking balance and rejects wrong RPC code', async t => {
  const rows = fixture(), root = await referenceRoot(rows), { store } = storeFor(t, root);
  putAll(store, rows); await verifyState(store, root);
  let badCode = true;
  const data = new Map(rows.map(row => [row.address, row]));
  const rpc = { assertCanonical: async () => {}, batch: async calls => calls.map(({ method, params: [address] }) => {
    if (method === 'eth_getBalance') return '0x' + BigInt(data.get(address).balanceWei).toString(16);
    return address === B ? (badCode ? '0x6000' : code) : address === D ? delegated : '0x';
  }) };
  await assert.rejects(classifyHolders(store, rpc, { block: 42 }), /codeHash/);
  assert.equal(store.get('classificationsComplete'), undefined);
  badCode = false; await classifyHolders(store, rpc, { block: 42 });
  const result = summarize(store);
  assert.equal(result.holders, 3); assert.equal(result.zeroBalanceAccounts, 1);
  assert.equal(result.byType.CONTRACT.balanceWei, 25n);
  assert.equal(result.byType.EOA_DELEGATED.addresses, 1);
});

test('RPC failover validates the supplying chain during pinning and the pinned hash during reads', async () => {
  let failPrimary = true, fallbackChain = '0x1', fallbackHash = HASH;
  const reads = [];
  const rpc = new Rpc(['https://primary.example', 'https://fallback.example'], { delay: 0, retries: 0, fetcher: async (url, init) => {
    const request = JSON.parse(init.body), fallback = url.includes('fallback');
    if (!fallback && failPrimary && request.method !== 'eth_chainId') throw new Error('primary offline');
    let result;
    if (request.method === 'eth_chainId') result = fallback ? fallbackChain : '0x659';
    else if (request.method === 'eth_getBlockByNumber') result = { number: '0x2a', hash: fallback ? fallbackHash : HASH };
    else { reads.push(url); result = '0x1'; }
    return fetchResponse(json({ id: request.id, result }));
  } });
  await assert.rejects(rpc.pin(42), /Expected chain ID/);
  assert.equal(rpc.identity, undefined);
  rpc.active = 0; fallbackChain = '0x659'; failPrimary = false;
  await rpc.pin(42);
  failPrimary = true; fallbackHash = ETH_HASH;
  await assert.rejects(rpc.call('eth_getBalance', [A, '0x2a']), /identity mismatch/);
  assert.equal(reads.length, 0);
  fallbackHash = HASH;
  assert.equal(await rpc.call('eth_getBalance', [A, '0x2a']), '0x1');
  assert.deepEqual(reads, ['https://fallback.example']);
});

test('bridge raw balance equality does not establish reconciliation; supplied ledger is explicit', () => {
  const alpha = { block: 42, blockHash: HASH }, ethereum = { block: 9, blockHash: ETH_HASH };
  assert.equal(bridgeReconciliation('100', '100', alpha, ethereum).status, 'unadjusted_match');
  const ledger = { format: 'gravity-bridge-adjustments-v1', alpha, ethereum, entries: [
    { kind: 'deposit_pending', amountWei: '7', evidence: 'Ethereum receipt/message 1' },
    { kind: 'withdrawal_pending', amountWei: '5', evidence: 'Alpha withdrawal/message 2' },
    { kind: 'protocol_adjustment', amountWei: '-2', evidence: 'Verified protocol adjustment record' },
  ] };
  const result = bridgeReconciliation('100', '110', alpha, ethereum, json(ledger));
  assert.equal(result.status, 'adjusted_match'); assert.equal(result.adjustmentsVerified, false);
  assert.equal(bridgeReconciliation('100', '111', alpha, ethereum, json(ledger)).residualWei, 1n);
  ledger.alpha = { ...alpha, block: 41 };
  assert.throws(() => bridgeReconciliation('100', '110', alpha, ethereum, json(ledger)), /identity mismatch/);
});

test('CSV neutralizes contract-supplied formulas while JSONL preserves original evidence', async t => {
  const versions = ['=HYPERLINK("https://example.invalid")', '+1+1', '-1+1', '@SUM(1)', '\t=1+1', '\r=1+1', ' =1+1'];
  const dir = directory(t);
  const store = {
    get: key => key === 'verifiedRoot' ? HASH : key === 'classificationsComplete',
    *holders() { for (const version of versions) yield {
      address: B, balanceWei: '1', nonce: '0', codeHash: keccak256(code), codeKind: 'CONTRACT',
      classification: { type: 'CONTRACT', safe: { verified: false, version, threshold: 1, owners: [A] } },
    }; },
  };
  await writeExports(store, dir, { status: 'state_verified', block: 42 });
  const csv = readFileSync(join(dir, 'exports/holders.all.csv'), 'utf8');
  for (const version of versions) assert(csv.includes(`"'${version.replaceAll('"', '""')}"`));
  const rows = readFileSync(join(dir, 'exports/holders.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.safe.version), versions);
});

test('CLI: both full sources, resume, missing-zero rejection, Ethereum arithmetic and checksums', async t => {
  const dir = directory(t), rows = fixture(), root = await referenceRoot(rows);
  const sorted = [...rows].sort((a, b) => a.trieKey.localeCompare(b.trieKey));
  const total = rows.reduce((sum, row) => sum + BigInt(row.balanceWei), 0n), byAddress = new Map(rows.map(row => [row.address, row]));
  const stateFile = join(dir, 'state.jsonl'); writeFileSync(stateFile, [json({ root }), ...rows.map(row => json(dumpRow(row)))].join('\n'));
  const erc20 = new Interface(['function nativeToken() view returns (address)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
  let sourceCalls = 0;
  const handle = (request, ethereum) => {
    const { id, method, params } = request; let result;
    if (method === 'eth_chainId') result = ethereum ? '0x1' : '0x659';
    else if (method === 'eth_getBlockByNumber') result = { number: ethereum ? '0x9' : '0x2a', hash: ethereum ? ETH_HASH : HASH, stateRoot: root, timestamp: '0x3e8' };
    else if (method === 'eth_getCode') { assert.equal(params[1], '0x2a'); result = params[0] === B ? code : params[0] === D ? delegated : '0x'; }
    else if (method === 'eth_getBalance') { assert.equal(params[1], '0x2a'); result = '0x' + BigInt(byAddress.get(params[0]).balanceWei).toString(16); }
    else if (method === 'debug_accountRange') {
      sourceCalls++; assert.equal(params[0].blockHash, HASH); assert.deepEqual(params.slice(3), [true, true, true]);
      const rest = sorted.filter(row => params[1] === '0x' || row.trieKey >= params[1]);
      result = { root: root.slice(2), accounts: Object.fromEntries(rest.slice(0, params[2]).map(row => [row.address, dumpRow(row)])) };
      if (rest.length > params[2]) result.next = bytes(rest[params[2]].trieKey).toString('base64');
    } else if (method === 'eth_call' && ethereum) {
      assert.equal(params[1], '0x9'); const call = erc20.parseTransaction({ data: params[0].data });
      result = erc20.encodeFunctionResult(call.name, [{ nativeToken: G_TOKEN, decimals: 18n, balanceOf: total + 12n }[call.name]]);
    } else throw new Error(`Unexpected ${method}`);
    return { jsonrpc: '2.0', id, result };
  };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    try { const input = parse(body), ethereum = req.url === '/ethereum'; res.setHeader('content-type', 'application/json'); res.end(json(Array.isArray(input) ? input.map(request => handle(request, ethereum)).reverse() : handle(input, ethereum))); }
    catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const run = async (out, extra) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../gravity-holders.mjs', import.meta.url)), '--block', '42', '--rpc', endpoint, '--fallback-rpc', endpoint, '--out', out, '--delay-ms', '0', '--page-size', '2', '--verify-batch-size', '2', ...extra]);
    let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.stdout.resume();
    const [code] = await once(child, 'close'); return { code, stderr };
  };
  const fileOut = join(dir, 'file-run'), fileArgs = ['--mode', 'state-file', '--state-file', stateFile];
  const first = await run(fileOut, fileArgs); assert.equal(first.code, 0, first.stderr);
  const report = JSON.parse(readFileSync(join(fileOut, 'report.json')));
  assert.equal(report.summary.holders, 3); assert.equal(report.summary.nativeBalanceWei, total.toString()); assert.equal(report.verifiedRoot, root);
  const before = readFileSync(join(fileOut, 'exports/holders.all.csv'), 'utf8');
  assert(before.includes(B), 'staking custody remains a native holder');
  const resumed = await run(fileOut, fileArgs); assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(readFileSync(join(fileOut, 'exports/holders.all.csv'), 'utf8'), before);
  for (const line of readFileSync(join(fileOut, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [expected, file] = line.split('  '); assert.equal(createHash('sha256').update(readFileSync(join(fileOut, file))).digest('hex'), expected);
  }
  const rpcOut = join(dir, 'rpc-run'); const viaRpc = await run(rpcOut, ['--mode', 'rpc-state', '--state-rpc', endpoint]);
  assert.equal(viaRpc.code, 0, viaRpc.stderr); assert.equal(sourceCalls, 2);
  assert.equal(readFileSync(join(rpcOut, 'exports/holders.all.csv'), 'utf8'), before);
  const badFile = join(dir, 'missing-zero.jsonl'); writeFileSync(badFile, [json({ root }), ...rows.filter(row => row.balanceWei !== '0').map(row => json(dumpRow(row)))].join('\n'));
  const badOut = join(dir, 'bad-run'); const bad = await run(badOut, ['--mode', 'state-file', '--state-file', badFile]);
  assert.equal(bad.code, 1); assert.match(bad.stderr, /stateRoot mismatch/); assert(!existsSync(join(badOut, 'exports/holders.all.csv')));
  const bridgeArgs = [...fileArgs, '--ethereum-rpc', endpoint + '/ethereum', '--ethereum-block', '9'];
  const raw = await run(join(dir, 'raw-bridge'), bridgeArgs); assert.equal(raw.code, 2, raw.stderr);
  const ledger = join(dir, 'ledger.json'); writeFileSync(ledger, json({ format: 'gravity-bridge-adjustments-v1', alpha: { block: 42, blockHash: HASH }, ethereum: { block: 9, blockHash: ETH_HASH }, entries: [{ kind: 'deposit_pending', amountWei: '12', evidence: 'test message / receipt' }] }));
  const adjusted = await run(join(dir, 'adjusted'), [...bridgeArgs, '--bridge-adjustments', ledger]); assert.equal(adjusted.code, 0, adjusted.stderr);
});
