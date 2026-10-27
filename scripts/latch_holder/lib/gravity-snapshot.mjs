import { Interface, ZeroAddress, formatUnits, getAddress, id, keccak256 } from 'ethers';
import { getProxyFactoryDeployment, getSafeSingletonDeployment, getSafeL2SingletonDeployment } from '@safe-global/safe-deployments';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const TOKENS = [
  { symbol: 'atUSD', address: '0xc4af68dd5b96f0a544c4417407773fefdc97f58d' },
  { symbol: 'atETH', address: '0xc314b8637b05a294ae9d9c29300d5f667c748bad' },
];
export const ERC20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
export const SAFE = new Interface([
  'function masterCopy() view returns (address)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function proxyRuntimeCode() view returns (bytes)',
]);
const TRANSFER = id('Transfer(address,address,uint256)');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lower = address => getAddress(address).toLowerCase();
export const hex = number => `0x${BigInt(number).toString(16)}`;

export class RpcError extends Error {
  constructor(error) {
    super(error.message);
    this.code = error.code;
  }
}
const isRevert = error => error instanceof RpcError &&
  (error.code === 3 || /execution reverted|VM execution error.*revert/i.test(error.message));
const isRangeError = error => /logs count|too many (results|logs)|block range|response size|query returned more|limit.*10000/i.test(error.message);
const isTransient = error => !(error instanceof RpcError) ||
  /rate|too many requests|timeout|timed out|temporar|busy|limit exceeded/i.test(error.message);

export async function fetchJson(url, init = {}, retries = 5) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        ...init, signal: AbortSignal.timeout(45_000),
        headers: { 'User-Agent': 'gravity-holder-snapshot/1.0', 'Content-Type': 'application/json', ...init.headers },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (attempt >= retries || error.retryable === false) throw error;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
}

export class Rpc {
  constructor(url, { batchSize = 20, delay = 200 } = {}) {
    this.url = url;
    this.batchSize = batchSize;
    this.delay = delay;
    this.sequence = 0;
  }
  async request(payload) {
    if (this.delay) await sleep(this.delay);
    return fetchJson(this.url, { method: 'POST', body: JSON.stringify(payload) });
  }
  async call(method, params) {
    const request = { jsonrpc: '2.0', id: ++this.sequence, method, params };
    for (let attempt = 0; ; attempt++) {
      const response = await this.request(request);
      if (response.id !== request.id) throw new Error('RPC response ID mismatch');
      if (!response.error) {
        if (!Object.hasOwn(response, 'result')) throw new Error('RPC result missing');
        return response.result;
      }
      const error = new RpcError(response.error);
      if (attempt >= 5 || isRangeError(error) || !isTransient(error)) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
  // Responses may arrive out of order. Retry failed entries individually;
  // a transport/archive failure must never turn into zero balance or EOA.
  async batch(calls) {
    if (calls.length === 1) return [await this.call(calls[0].method, calls[0].params)];
    const requests = calls.map(({ method, params }) => ({ jsonrpc: '2.0', id: ++this.sequence, method, params }));
    if (!requests.length) return [];
    const responses = await this.request(requests);
    if (!Array.isArray(responses)) throw new Error('RPC must support JSON-RPC batches; try --batch-size 1');
    const byId = new Map(responses.map(response => [response.id, response]));
    if (byId.size !== requests.length) throw new Error('Incomplete or duplicate RPC batch response');
    const values = [];
    for (const request of requests) {
      const response = byId.get(request.id);
      if (!response) throw new Error('Missing RPC batch response');
      if (response.error) {
        if (!isTransient(new RpcError(response.error))) throw new RpcError(response.error);
        values.push(await this.call(request.method, request.params));
      } else {
        if (!Object.hasOwn(response, 'result')) throw new Error('RPC result missing');
        values.push(response.result);
      }
    }
    return values;
  }
}

export async function contractCall(rpc, address, abi, method, args, block, optional = false) {
  let data;
  try {
    data = await rpc.call('eth_call', [{ to: address, data: abi.encodeFunctionData(method, args) }, hex(block)]);
  } catch (error) {
    if (optional && isRevert(error)) return null;
    throw error;
  }
  try {
    return abi.decodeFunctionResult(method, data)[0];
  } catch (error) {
    if (optional && (error.code === 'BAD_DATA' || error.code === 'BUFFER_OVERRUN' || error.code === 'INVALID_ARGUMENT')) return null;
    throw error;
  }
}

export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
}
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Only deterministic reads at a fixed block hash are cached. The current
// explorer holder list is deliberately fetched afresh on each invocation.
export class StateCache {
  constructor(file) { this.file = file; this.values = new Map(); }
  async open() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const text = await readFile(this.file, 'utf8');
      const end = text.lastIndexOf('\n') + 1;
      for (const line of text.slice(0, end).split('\n').filter(Boolean)) {
        const [key, value] = JSON.parse(line);
        this.values.set(key, value);
      }
      // Discard a partially written final line after an interrupted process.
      if (end !== text.length) await writeFile(this.file, text.slice(0, end));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  async putMany(entries) {
    if (!entries.length) return;
    await appendFile(this.file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    for (const [key, value] of entries) this.values.set(key, value);
  }
}

export async function discoverHolders(token, { explorer, limit = 0, progress = () => {}, getJson = fetchJson }) {
  const addresses = new Set();
  const cursors = new Set();
  let query = '', pages = 0;
  const startedAt = new Date().toISOString();
  while (true) {
    const data = await getJson(`${explorer}/api/v2/tokens/${token.address}/holders${query}`);
    if (!Array.isArray(data.items)) throw new Error('Invalid holders API response');
    for (const item of data.items) {
      const address = lower(item.address.hash);
      if (address !== ZeroAddress) addresses.add(address);
    }
    pages++;
    if (pages % 20 === 0) progress(`${token.symbol}: holders pages=${pages}, candidates=${addresses.size}`);
    if (limit && addresses.size >= limit) {
      return { addresses: [...addresses].slice(0, limit), source: { kind: 'current_holders_api', pages, truncated: true, startedAt, finishedAt: new Date().toISOString() } };
    }
    if (data.next_page_params == null) break;
    if (!data.items.length) throw new Error('Empty holders page with a next-page cursor');
    query = `?${new URLSearchParams(data.next_page_params)}`;
    if (cursors.has(query)) throw new Error('Repeated holders pagination cursor');
    cursors.add(query);
  }
  return { addresses: [...addresses], source: { kind: 'current_holders_api', pages, truncated: false, startedAt, finishedAt: new Date().toISOString() } };
}

export function transferAddresses(log, tokens, from, to) {
  const token = lower(log.address);
  const block = Number(BigInt(log.blockNumber));
  if (!tokens.includes(token) || block < from || block > to || log.removed ||
      log.topics?.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER || !/^0x[0-9a-f]{64}$/i.test(log.data)) {
    throw new Error('Invalid/out-of-range ERC-20 Transfer log');
  }
  const addresses = log.topics.slice(1).map(topic => {
    if (!/^0x0{24}[0-9a-f]{40}$/i.test(topic)) throw new Error('Malformed Transfer address topic');
    return lower(`0x${topic.slice(-40)}`);
  }).filter(address => address !== ZeroAddress);
  return { token, addresses };
}

export async function discoverTransfers(rpc, tokens, options) {
  const { block, blockHash, fromBlock = 0, chunkSize = 1_000_000, cacheDir, progress = () => {} } = options;
  const tokenAddresses = tokens.map(token => token.address);
  const identity = JSON.stringify({ block, blockHash, fromBlock, tokens: tokenAddresses });
  const file = join(cacheDir, `transfers-${keccak256(Buffer.from(identity)).slice(2)}.json`);
  const checkpoint = await readJson(file);
  if (checkpoint && checkpoint.identity !== identity) throw new Error('Transfer checkpoint identity mismatch');
  const candidates = Object.fromEntries(tokenAddresses.map(address => [address, new Set(checkpoint?.candidates[address] ?? [])]));
  let from = checkpoint?.nextBlock ?? fromBlock;
  let step = checkpoint?.step ?? chunkSize;
  let logCount = checkpoint?.logCount ?? 0;
  while (from <= block) {
    const to = Math.min(block, from + step - 1);
    let logs;
    try {
      logs = await rpc.call('eth_getLogs', [{ address: tokenAddresses, topics: [TRANSFER], fromBlock: hex(from), toBlock: hex(to) }]);
    } catch (error) {
      if (step > 1 && (isRangeError(error) || /timeout|timed out/i.test(error.message))) {
        step = Math.max(1, Math.floor(step / 2));
        progress(`Reducing log range to ${step} blocks`);
        continue;
      }
      throw error;
    }
    if (!Array.isArray(logs)) throw new Error('Invalid eth_getLogs result');
    // Some providers silently cap logs at 10,000 rather than returning an error.
    if (logs.length >= 10_000) {
      if (step === 1) throw new Error('Single-block log limit reached; use a higher-capacity RPC');
      step = Math.max(1, Math.floor(step / 2));
      continue;
    }
    for (const log of logs) {
      const parsed = transferAddresses(log, tokenAddresses, from, to);
      parsed.addresses.forEach(address => candidates[parsed.token].add(address));
    }
    logCount += logs.length;
    from = to + 1;
    if (logs.length < 1000) step = Math.min(chunkSize, step * 2);
    await atomicJson(file, { identity, nextBlock: from, step, logCount, candidates: Object.fromEntries(Object.entries(candidates).map(([key, set]) => [key, [...set]])) });
    progress(`Transfers through ${to}/${block}, logs=${logCount}, candidates=${Object.values(candidates).reduce((sum, set) => sum + set.size, 0)}`);
  }
  return Object.fromEntries(tokens.map(token => [token.address, {
    addresses: [...candidates[token.address]],
    source: { kind: 'transfer_logs', fromBlock, toBlock: block, logCountCombined: logCount, truncated: fromBlock !== 0 },
  }]));
}

export async function queryBalances(rpc, token, addresses, block, cache, progress = () => {}) {
  const keys = addresses.map(address => `balance:${token.address}:${address}`);
  const missing = addresses.filter((_, index) => !cache.values.has(keys[index]));
  for (let i = 0; i < missing.length; i += rpc.batchSize) {
    const batch = missing.slice(i, i + rpc.batchSize);
    const values = await rpc.batch(batch.map(address => ({ method: 'eth_call', params: [
      { to: token.address, data: ERC20.encodeFunctionData('balanceOf', [address]) }, hex(block),
    ] })));
    await cache.putMany(values.map((value, index) => [
      `balance:${token.address}:${batch[index]}`, ERC20.decodeFunctionResult('balanceOf', value)[0].toString(),
    ]));
    if (i % (rpc.batchSize * 50) === 0) progress(`${token.symbol}: balances ${Math.min(i + batch.length, missing.length)}/${missing.length} uncached`);
  }
  return addresses.map((address, index) => ({ address, balanceRaw: cache.values.get(keys[index]) })).filter(row => BigInt(row.balanceRaw) > 0n);
}

export async function loadSafeRegistry(rpc, block) {
  const implementationHashes = new Map(), factories = new Map();
  // keccak256(deployedBytecode) from the official @safe-global/safe-contracts
  // 1.4.1 artifact: build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json.
  // Its factory exposes proxyCreationCode(), but not proxyRuntimeCode().
  // Artifact: https://unpkg.com/@safe-global/safe-contracts@1.4.1/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json
  const proxyHashes = new Set(['0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c']);
  for (const version of ['1.0.0', '1.1.1', '1.2.0', '1.3.0', '1.4.1', '1.5.0']) {
    for (const accessor of [getSafeSingletonDeployment, getSafeL2SingletonDeployment]) {
      const deployment = accessor({ version });
      for (const [type, entry] of Object.entries(deployment?.deployments ?? {})) {
        if (type !== 'zksync') implementationHashes.set(entry.codeHash.toLowerCase(), version);
      }
    }
    const factory = getProxyFactoryDeployment({ version });
    for (const [type, entry] of Object.entries(factory?.deployments ?? {})) {
      if (type !== 'zksync') factories.set(entry.address, entry.codeHash.toLowerCase());
    }
  }
  for (const [address, expectedHash] of factories) {
    const code = await rpc.call('eth_getCode', [address, hex(block)]);
    if (code === '0x' || keccak256(code) !== expectedHash) continue;
    const runtime = await contractCall(rpc, address, SAFE, 'proxyRuntimeCode', [], block, true);
    if (runtime && runtime !== '0x') proxyHashes.add(keccak256(runtime));
  }
  return { implementationHashes, proxyHashes };
}

export async function classify(rpc, address, code, block, registry) {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(code)) throw new Error('Invalid eth_getCode result');
  if (code === '0x') return { type: 'EOA', evidence: 'empty_code_at_block' };
  if (/^0xef0100[0-9a-f]{40}$/i.test(code)) {
    return { type: 'EOA_DELEGATED', evidence: 'eip7702_delegation', delegation: `0x${code.slice(8)}` };
  }
  const other = { type: 'CONTRACT', evidence: 'code_present_safe_not_verified' };
  const masterCopy = await contractCall(rpc, address, SAFE, 'masterCopy', [], block, true);
  if (!masterCopy || masterCopy === ZeroAddress) return other;
  const owners = await contractCall(rpc, address, SAFE, 'getOwners', [], block, true);
  const threshold = await contractCall(rpc, address, SAFE, 'getThreshold', [], block, true);
  if (!owners?.length || threshold == null || threshold < 1n || threshold > BigInt(owners.length)) return other;
  const version = await contractCall(rpc, address, SAFE, 'VERSION', [], block, true);
  const implementationCode = await rpc.call('eth_getCode', [masterCopy, hex(block)]);
  const knownVersion = registry.implementationHashes.get(keccak256(implementationCode));
  const slot0 = await rpc.call('eth_getStorageAt', [address, '0x0', hex(block)]);
  const validOwners = owners.every(owner => owner !== ZeroAddress && BigInt(owner) !== 1n) && new Set(owners.map(lower)).size === owners.length;
  const verified = registry.proxyHashes.has(keccak256(code)) && knownVersion && version === knownVersion &&
    /^0x[0-9a-f]{64}$/i.test(slot0) && lower(`0x${slot0.slice(-40)}`) === lower(masterCopy) && validOwners;
  return {
    type: verified ? 'SAFE' : 'CONTRACT',
    evidence: verified ? 'official_proxy_and_implementation_code_hashes' : 'safe_like_unverified',
    safe: { verified: Boolean(verified), implementation: lower(masterCopy), version, owners: owners.map(lower), threshold: Number(threshold), requiresMultipleSigners: threshold > 1n },
  };
}

export async function classifyHolders(rpc, rows, block, cache, registry, progress = () => {}) {
  const missingCode = rows.filter(row => !cache.values.has(`code:${row.address}`));
  for (let i = 0; i < missingCode.length; i += rpc.batchSize) {
    const batch = missingCode.slice(i, i + rpc.batchSize);
    const codes = await rpc.batch(batch.map(row => ({ method: 'eth_getCode', params: [row.address, hex(block)] })));
    await cache.putMany(codes.map((code, index) => [`code:${batch[index].address}`, code]));
    if (i % (rpc.batchSize * 50) === 0) progress(`Address code ${Math.min(i + batch.length, missingCode.length)}/${missingCode.length} uncached`);
  }
  let pending = [];
  for (const row of rows) {
    const key = `classification-v2:${row.address}`;
    let result = cache.values.get(key);
    if (!result) {
      result = await classify(rpc, row.address, cache.values.get(`code:${row.address}`), block, registry);
      pending.push([key, result]);
      if (pending.length >= 500) {
        await cache.putMany(pending);
        pending = [];
      }
    }
    Object.assign(row, result);
  }
  await cache.putMany(pending);
}

export function reconcile(rows, totalSupply, decimals) {
  const sum = rows.reduce((value, row) => value + BigInt(row.balanceRaw), 0n);
  const difference = BigInt(totalSupply) - sum;
  const byType = {};
  for (const row of rows) {
    const entry = byType[row.type] ??= { holders: 0, balanceRaw: '0' };
    entry.holders++;
    entry.balanceRaw = (BigInt(entry.balanceRaw) + BigInt(row.balanceRaw)).toString();
  }
  for (const entry of Object.values(byType)) entry.balance = formatUnits(entry.balanceRaw, decimals);
  return {
    holderCount: rows.length, holderBalanceRaw: sum.toString(), holderBalance: formatUnits(sum, decimals),
    totalSupplyRaw: totalSupply.toString(), totalSupply: formatUnits(totalSupply, decimals),
    differenceRaw: difference.toString(), difference: formatUnits(difference, decimals),
    supplyMatched: difference === 0n, byType,
  };
}

export function compareRows(left, right) {
  const a = new Map(left.map(row => [row.address, row]));
  const b = new Map(right.map(row => [row.address, row]));
  return {
    onlyHolders: [...a.keys()].filter(address => !b.has(address)),
    onlyTransfers: [...b.keys()].filter(address => !a.has(address)),
    differentBalances: [...a.keys()].filter(address => b.has(address) && a.get(address).balanceRaw !== b.get(address).balanceRaw),
  };
}

export function toCsv(rows, token, block) {
  const columns = ['token', 'token_address', 'block', 'address', 'balance_raw', 'balance', 'type', 'evidence', 'safe_version', 'safe_threshold', 'safe_owners', 'safe_implementation', 'delegation'];
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return columns.join(',') + '\n' + rows.map(row => [
    token.symbol, token.address, block, row.address, row.balanceRaw, row.balance, row.type, row.evidence,
    row.safe?.version, row.safe?.threshold, row.safe?.owners.join(';'), row.safe?.implementation, row.delegation,
  ].map(escape).join(',')).join('\n') + '\n';
}
