import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { id, keccak256, zeroPadValue, ZeroAddress } from 'ethers';
import {
  TOKENS, ERC20, SAFE, Rpc, RpcError, StateCache, contractCall, discoverHolders,
  discoverTransfers, queryBalances, classify, reconcile, compareRows, toCsv,
} from '../lib/gravity-snapshot.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const MASTER = '0x3333333333333333333333333333333333333333';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const token = TOKENS[0];
const transfer = (address, from, to, block = 3) => ({
  address, blockNumber: `0x${block.toString(16)}`, removed: false,
  topics: [id('Transfer(address,address,uint256)'), zeroPadValue(from, 32), zeroPadValue(to, 32)],
  data: zeroPadValue('0x01', 32),
});
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gravity-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('holders follows pagination, deduplicates addresses, and marks sample limits', async () => {
  const requests = [];
  const pages = [
    { items: [{ address: { hash: A } }], next_page_params: { address_hash: A, value: '7', items_count: 50 } },
    { items: [{ address: { hash: A } }, { address: { hash: B } }], next_page_params: null },
  ];
  const result = await discoverHolders(token, { explorer: 'http://example', getJson: async url => { requests.push(url); return pages.shift(); } });
  assert.deepEqual(result.addresses, [A, B]);
  assert.match(requests[1], /address_hash=0x111/);
  assert.equal(result.source.truncated, false);
  const sample = await discoverHolders(token, { explorer: 'http://example', limit: 1, getJson: async () => ({ items: [{ address: { hash: A } }], next_page_params: null }) });
  assert.equal(sample.source.truncated, true);
});

test('holders rejects repeating cursors and API errors', async () => {
  await assert.rejects(discoverHolders(token, { explorer: '', getJson: async () => ({ items: [{ address: { hash: A } }], next_page_params: { value: '1' } }) }), /Repeated/);
  await assert.rejects(discoverHolders(token, { explorer: '', getJson: async () => ({ error: 'no access' }) }), /Invalid/);
});

test('Transfer scan splits provider limits, includes senders, excludes zero and resumes', async t => {
  const cacheDir = await temporary(t);
  const ranges = [];
  const rpc = { call: async (method, [filter]) => {
    assert.equal(method, 'eth_getLogs');
    const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
    ranges.push([from, to]);
    if (to - from > 1) throw new RpcError({ code: -32005, message: 'logs count limit exceeded (10000)' });
    return [transfer(token.address, ZeroAddress, A, from), transfer(token.address, B, A, to)];
  } };
  const options = { block: 5, blockHash: BLOCK_HASH, cacheDir, chunkSize: 6 };
  const results = await discoverTransfers(rpc, [token], options);
  assert.deepEqual(results[token.address].addresses.sort(), [A, B]);
  assert.equal(results[token.address].source.truncated, false);
  const previous = ranges.length;
  await discoverTransfers(rpc, [token], options);
  assert.equal(ranges.length, previous, 'resumed scan should not repeat completed logs');
  assert.deepEqual(ranges.filter(([from, to]) => to - from <= 1), [[0, 0], [1, 2], [3, 4], [5, 5]]);
});

test('Transfer scan refuses logs outside the requested range', async t => {
  await assert.rejects(discoverTransfers({ call: async () => [transfer(token.address, A, B, 99)] }, [token], {
    block: 5, blockHash: BLOCK_HASH, cacheDir: await temporary(t),
  }), /out-of-range/);
});

test('historical balances use exact block, preserve big integers, exclude zero, and cache', async t => {
  const cache = await new StateCache(join(await temporary(t), 'state.jsonl')).open();
  let requests = 0;
  const rpc = { batchSize: 20, batch: async calls => {
    requests++;
    calls.forEach(call => assert.equal(call.params[1], '0x2a'));
    return ['9007199254740993123456789', '0'].map(value => ERC20.encodeFunctionResult('balanceOf', [value]));
  } };
  const rows = await queryBalances(rpc, token, [A, B], 42, cache);
  assert.deepEqual(rows, [{ address: A, balanceRaw: '9007199254740993123456789' }]);
  await queryBalances(rpc, token, [A, B], 42, cache);
  assert.equal(requests, 1);
});

test('supply mismatch exposes historical holder omitted by current API', () => {
  const current = [{ address: A, balanceRaw: '60', type: 'EOA' }];
  const historical = [...current, { address: B, balanceRaw: '40', type: 'CONTRACT' }];
  assert.equal(reconcile(current, 100n, 18).differenceRaw, '40');
  assert.equal(reconcile(historical, 100n, 18).supplyMatched, true);
  assert.deepEqual(compareRows(current, historical).onlyTransfers, [B]);
  assert.equal(reconcile([{ ...current[0], balanceRaw: '101' }], 100n, 18).differenceRaw, '-1');
});

test('EOA, delegated EOA, generic contracts and Safe lookalikes remain distinct', async () => {
  const registry = { implementationHashes: new Map(), proxyHashes: new Set() };
  const rpc = { call: async () => { throw new RpcError({ code: 3, message: 'execution reverted' }); } };
  assert.equal((await classify(rpc, A, '0x', 42, registry)).type, 'EOA');
  const delegated = await classify(rpc, A, `0xef0100${B.slice(2)}`, 42, registry);
  assert.equal(delegated.type, 'EOA_DELEGATED');
  assert.equal(delegated.delegation, B);
  assert.equal((await classify(rpc, A, '0x6000', 42, registry)).type, 'CONTRACT');
  await assert.rejects(classify(rpc, A, '0x0', 42, registry), /Invalid/);
});

function safeRpc({ threshold = 2, storage = MASTER, fail = false } = {}) {
  return { call: async (method, params) => {
    assert.equal(params.at(-1), '0x2a');
    if (fail) throw new RpcError({ code: -32000, message: 'missing trie node' });
    if (method === 'eth_getCode') return '0x6001';
    if (method === 'eth_getStorageAt') return zeroPadValue(storage, 32);
    const call = SAFE.parseTransaction({ data: params[0].data });
    const result = { masterCopy: MASTER, getOwners: [A, B], getThreshold: threshold, VERSION: '1.4.1' }[call.name];
    return SAFE.encodeFunctionResult(call.name, [result]);
  } };
}

test('Safe verification needs official proxy, official implementation, matching storage and valid threshold', async () => {
  const registry = { implementationHashes: new Map([[keccak256('0x6001'), '1.4.1']]), proxyHashes: new Set([keccak256('0x6000')]) };
  const verified = await classify(safeRpc(), A, '0x6000', 42, registry);
  assert.equal(verified.type, 'SAFE');
  assert.equal(verified.safe.threshold, 2);
  assert.deepEqual(verified.safe.owners, [A, B]);
  const singleSigner = await classify(safeRpc({ threshold: 1 }), A, '0x6000', 42, registry);
  assert.equal(singleSigner.type, 'SAFE');
  assert.equal(singleSigner.safe.requiresMultipleSigners, false);
  const imitation = await classify(safeRpc(), A, '0x6002', 42, registry);
  assert.equal(imitation.type, 'CONTRACT');
  assert.equal(imitation.evidence, 'safe_like_unverified');
  assert.equal((await classify(safeRpc({ storage: B }), A, '0x6000', 42, registry)).type, 'CONTRACT');
  assert.equal((await classify(safeRpc({ threshold: 3 }), A, '0x6000', 42, registry)).type, 'CONTRACT');
});

test('archive/RPC errors must not become generic contracts or zero balances', async () => {
  await assert.rejects(classify(safeRpc({ fail: true }), A, '0x6000', 42, { proxyHashes: new Set() }), /missing trie node/);
  await assert.rejects(contractCall({ call: async () => { throw new Error('timeout'); } }, A, SAFE, 'masterCopy', [], 42, true), /timeout/);
});

test('RPC batch uses IDs rather than order and rejects missing entries', async () => {
  const rpc = new Rpc('http://unused', { delay: 0 });
  rpc.request = async requests => requests.map(request => ({ id: request.id, result: request.params[0] })).reverse();
  assert.deepEqual(await rpc.batch([{ method: 'm', params: ['a'] }, { method: 'm', params: ['b'] }]), ['a', 'b']);
  rpc.request = async requests => [{ id: requests[0].id, result: 'a' }];
  await assert.rejects(rpc.batch([{ method: 'm', params: [] }, { method: 'm', params: [] }]), /Incomplete/);
});

test('cache recovers from a partially written final line', async t => {
  const file = join(await temporary(t), 'cache.jsonl');
  await writeFile(file, '["a","1"]\n["broken"');
  const cache = await new StateCache(file).open();
  await cache.putMany([['b', '2']]);
  const reloaded = await new StateCache(file).open();
  assert.deepEqual([...reloaded.values], [['a', '1'], ['b', '2']]);
});

test('CSV retains exact raw amounts and safe owner evidence', () => {
  const csv = toCsv([{ address: A, balanceRaw: '9999999999999999999999', balance: '9999.999999999999999999', type: 'SAFE', safe: { owners: [A, B], threshold: 2 } }], token, 42);
  assert.match(csv, /9999999999999999999999/);
  assert.match(csv, new RegExp(`${A};${B}`));
});

test('CLI both modes exports a historical mismatch, full Transfer reconciliation, and exit 2', { timeout: 15_000 }, async t => {
  const dir = await temporary(t);
  const header = { number: '0x2a', hash: BLOCK_HASH, timestamp: '0x64' };
  const handleRpc = ({ id: requestId, method, params }) => {
    let result;
    if (method === 'eth_chainId') result = '0x659';
    else if (method === 'eth_getBlockByNumber') result = header;
    else if (method === 'eth_getCode') result = TOKENS.some(item => item.address === params[0]) ? '0x6000' : '0x';
    else if (method === 'eth_getLogs') result = TOKENS.flatMap(item => [transfer(item.address, ZeroAddress, A), transfer(item.address, ZeroAddress, B)]);
    else if (method === 'eth_call') {
      assert.equal(params[1], '0x2a');
      const call = ERC20.parseTransaction({ data: params[0].data });
      const value = {
        symbol: TOKENS.find(item => item.address === params[0].to).symbol,
        decimals: 18, totalSupply: 100n, balanceOf: call.name === 'balanceOf' && call.args[0].toLowerCase() === A ? 60n : 40n,
      }[call.name];
      result = ERC20.encodeFunctionResult(call.name, [value]);
    } else throw new Error(`Unexpected RPC ${method}`);
    return { jsonrpc: '2.0', id: requestId, result };
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify({ items: [{ address: { hash: A }, value: '100' }], next_page_params: null }));
    } else {
      let body = '';
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body);
      response.end(JSON.stringify(Array.isArray(data) ? data.map(handleRpc).reverse() : handleRpc(data)));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../gravity-holders.mjs', import.meta.url)), '--block', '42', '--mode', 'both', '--rpc', url, '--explorer', url, '--out', join(dir, 'out'), '--cache-dir', join(dir, 'cache'), '--delay-ms', '0']);
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = await new Promise(resolve => child.on('close', resolve));
  assert.equal(exit, 2, output);
  const report = JSON.parse(await readFile(join(dir, 'out', '42', 'comparison.json'), 'utf8'));
  for (const symbol of ['atUSD', 'atETH']) {
    assert.equal(report.tokens[symbol].holdersStatus, 'supply_mismatch');
    assert.equal(report.tokens[symbol].transfersStatus, 'reconciled');
    assert.deepEqual(report.tokens[symbol].onlyTransfers, [B]);
    assert.equal(report.tokens[symbol].holdersSummary.differenceRaw, '40');
    assert.equal(report.tokens[symbol].transfersSummary.differenceRaw, '0');
  }
});
