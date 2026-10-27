#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { formatUnits } from 'ethers';
import {
  TOKENS, ERC20, Rpc, StateCache, hex, contractCall, atomicJson, discoverHolders,
  discoverTransfers, queryBalances, loadSafeRegistry, classifyHolders, reconcile, compareRows, toCsv,
} from './lib/gravity-snapshot.mjs';

const packageDir = fileURLToPath(new URL('.', import.meta.url));
const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'both' }, block: { type: 'string' },
  rpc: { type: 'string', default: process.env.GRAVITY_RPC_URL || 'https://rpc.gravity.xyz' },
  explorer: { type: 'string', default: 'https://api.explorer.gravity.xyz' },
  token: { type: 'string', default: 'all' }, out: { type: 'string', default: resolve(packageDir, 'output/gravity') },
  'cache-dir': { type: 'string', default: resolve(packageDir, '.context/gravity-cache') },
  'from-block': { type: 'string', default: '0' }, 'chunk-size': { type: 'string', default: '1000000' },
  'batch-size': { type: 'string', default: '20' }, 'delay-ms': { type: 'string', default: '200' },
  'limit-holders': { type: 'string', default: '0' }, help: { type: 'boolean', short: 'h' },
} });

if (values.help) {
  console.log(`Gravity atUSD / atETH holder snapshots (Node.js >=22)

cd scripts/latch_holder
npm run snapshot:gravity -- --block 130827456 --mode both

--mode holders|transfers|both  Candidate discovery method (default both)
--block NUMBER                Required, state at the END of this block
--rpc URL                     Archive RPC, or GRAVITY_RPC_URL
--explorer URL                Blockscout API host
--token all|atUSD|atETH        Default all
--out DIRECTORY               Default scripts/latch_holder/output/gravity
--cache-dir DIRECTORY         Historical reads and transfer checkpoints
--from-block NUMBER           Transfer start, default 0; nonzero marks PARTIAL
--chunk-size NUMBER           Max log range, automatically reduced on limits
--batch-size NUMBER           RPC batch size (default 20)
--delay-ms NUMBER             Delay per HTTP RPC request (default 200)
--limit-holders NUMBER        SAMPLE ONLY: cap API candidates (default 0 = all)

Exit 0: supply reconciled; 2: mismatch, partial scan, or cross-method difference;
1: RPC/API/validation failure. Current holders API is NOT a historical snapshot.
No private key needed. Do not run concurrent processes using the same cache.`);
  process.exit(0);
}

function integer(name, minimum = 0) {
  const value = values[name];
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }
  return Number(value);
}
const progress = message => console.error(`[${new Date().toISOString()}] ${message}`);

async function main() {
  const block = integer('block');
  const fromBlock = integer('from-block');
  const limit = integer('limit-holders');
  const chunkSize = integer('chunk-size', 1);
  if (fromBlock > block) throw new Error('--from-block exceeds --block');
  if (!['holders', 'transfers', 'both'].includes(values.mode)) throw new Error('Invalid --mode');
  if (!['all', 'atUSD', 'atETH'].includes(values.token)) throw new Error('Invalid --token');
  for (const name of ['rpc', 'explorer']) {
    if (!['https:', 'http:'].includes(new URL(values[name]).protocol)) throw new Error(`Invalid --${name} URL`);
  }
  const tokens = TOKENS.filter(token => values.token === 'all' || token.symbol === values.token);
  const rpc = new Rpc(values.rpc, { batchSize: integer('batch-size', 1), delay: integer('delay-ms') });
  const chainId = Number(BigInt(await rpc.call('eth_chainId', [])));
  if (chainId !== 1625) throw new Error(`Expected Gravity Alpha chain ID 1625, received ${chainId}`);
  const header = await rpc.call('eth_getBlockByNumber', [hex(block), false]);
  if (!header?.hash || Number(BigInt(header.number)) !== block) throw new Error('Target block is unavailable');
  const cacheDir = resolve(values['cache-dir'], `${chainId}-${block}-${header.hash.slice(2)}`);
  const cache = await new StateCache(join(cacheDir, 'state.jsonl')).open();
  const out = resolve(values.out, String(block));
  await mkdir(out, { recursive: true });
  progress(`Snapshot block=${block}, hash=${header.hash}, chain=${chainId}, mode=${values.mode}`);
  const metadata = {};
  for (const token of tokens) {
    const code = await rpc.call('eth_getCode', [token.address, hex(block)]);
    if (code === '0x') throw new Error(`${token.symbol} not deployed at target block`);
    const decimals = Number(await contractCall(rpc, token.address, ERC20, 'decimals', [], block));
    const totalSupply = await contractCall(rpc, token.address, ERC20, 'totalSupply', [], block);
    const symbol = await contractCall(rpc, token.address, ERC20, 'symbol', [], block);
    if (symbol !== token.symbol) throw new Error(`Unexpected symbol for ${token.address}: ${symbol}`);
    metadata[token.address] = { decimals, totalSupply };
  }
  const registry = await loadSafeRegistry(rpc, block);
  progress(`Safe registry: ${registry.proxyHashes.size} verified proxy code hashes available at target block`);
  const results = {};
  const modes = values.mode === 'both' ? ['holders', 'transfers'] : [values.mode];
  let invalid = false;
  for (const mode of modes) {
    results[mode] = {};
    const transferCandidates = mode === 'transfers' ? await discoverTransfers(rpc, tokens, {
      block, blockHash: header.hash, fromBlock, chunkSize, cacheDir, progress,
    }) : null;
    for (const token of tokens) {
      const candidates = mode === 'holders'
        ? await discoverHolders(token, { explorer: values.explorer.replace(/\/$/, ''), limit, progress })
        : transferCandidates[token.address];
      const { decimals, totalSupply } = metadata[token.address];
      progress(`${mode}/${token.symbol}: ${candidates.addresses.length} candidates; querying historical balances`);
      const rows = await queryBalances(rpc, token, candidates.addresses, block, cache, progress);
      await classifyHolders(rpc, rows, block, cache, registry, progress);
      for (const row of rows) row.balance = formatUnits(row.balanceRaw, decimals);
      rows.sort((a, b) => BigInt(a.balanceRaw) === BigInt(b.balanceRaw)
        ? a.address.localeCompare(b.address) : BigInt(a.balanceRaw) > BigInt(b.balanceRaw) ? -1 : 1);
      const summary = reconcile(rows, totalSupply, decimals);
      const status = candidates.source.truncated ? 'partial' : summary.supplyMatched ? 'reconciled' : 'supply_mismatch';
      if (status !== 'reconciled') invalid = true;
      const finalHeader = await rpc.call('eth_getBlockByNumber', [hex(block), false]);
      if (finalHeader?.hash !== header.hash) throw new Error('Target block hash changed; discard this run');
      const report = {
        schemaVersion: 1, status, chainId, block, blockHash: header.hash,
        blockTimestamp: Number(BigInt(header.timestamp)), generatedAt: new Date().toISOString(),
        token: { ...token, decimals }, mode, source: candidates.source,
        candidateCount: candidates.addresses.length, summary,
        caveats: [
          ...(mode === 'holders' ? ['Candidate list comes from a live current index; past holders may be missing and pagination is not an atomic snapshot.'] : []),
          'Supply reconciliation assumes sum(balanceOf(nonzero holders)) equals totalSupply. Nonstandard/rebasing tokens need review.',
          'EOA means empty code at this block; it does not prove private-key control or exclude destroyed/undeployed contracts or precompiles.',
          'SAFE requires recognized proxy and implementation runtime code; custom Safe variants remain CONTRACT with evidence.',
          'Direct token holders only; vault/pool balances are not attributed to underlying users.',
        ], rows,
      };
      await atomicJson(join(out, `${token.symbol}-${mode}.json`), report);
      await writeFile(join(out, `${token.symbol}-${mode}.csv`), toCsv(rows, token, block));
      results[mode][token.symbol] = report;
      progress(`${mode}/${token.symbol}: ${status}, holders=${rows.length}, difference=${summary.difference}`);
    }
  }
  if (values.mode === 'both') {
    const comparison = { chainId, block, blockHash: header.hash, tokens: {} };
    for (const token of tokens) {
      const holders = results.holders[token.symbol], transfers = results.transfers[token.symbol];
      const differences = compareRows(holders.rows, transfers.rows);
      const matched = Object.values(differences).every(list => list.length === 0);
      if (!matched) invalid = true;
      comparison.tokens[token.symbol] = {
        matched, holdersStatus: holders.status, transfersStatus: transfers.status,
        holdersSummary: holders.summary, transfersSummary: transfers.summary, ...differences,
      };
    }
    await atomicJson(join(out, 'comparison.json'), comparison);
  }
  console.log(`Reports: ${out}`);
  process.exitCode = invalid ? 2 : 0;
}

main().catch(error => {
  console.error(`Snapshot failed: ${error.message}`);
  process.exitCode = 1;
});
