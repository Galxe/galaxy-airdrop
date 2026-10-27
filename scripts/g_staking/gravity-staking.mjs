#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Rpc } from './lib/rpc.mjs';
import { Store, acquireLock, json } from './lib/store.mjs';
import { CONTRACT, ABI_HASH, preflight, collectLogs, collectPositions, reconcile } from './lib/snapshot.mjs';
import { writeExports, sealManifest } from './lib/export.mjs';

const packageDir = fileURLToPath(new URL('.', import.meta.url));
const { values } = parseArgs({ options: {
  block: { type: 'string' }, rpc: { type: 'string' }, 'fallback-rpc': { type: 'string' }, out: { type: 'string' },
  'from-block': { type: 'string', default: '0' }, 'chunk-size': { type: 'string', default: '1000000' },
  'log-limit': { type: 'string', default: '10000' }, 'batch-size': { type: 'string', default: '10' },
  'delay-ms': { type: 'string', default: '200' }, 'limit-users': { type: 'string', default: '0' },
  'preflight-only': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });

if (values.help) {
  console.log(`Gravity Alpha native-G staking snapshot (Node >=22.13)

npm run snapshot:staking -- --block NUMBER [--out RUN_DIRECTORY]

--block NUMBER          Required; state at the end of this block
--rpc URL               Defaults to GRAVITY_ALPHA_RPCURL, GRAVITY_RPC_URL, public RPC
--fallback-rpc URL      Defaults to GRAVITY_ALPHA_FAILOVERRPCURL or public RPC
--from-block NUMBER     Default 0; nonzero ALWAYS marks output partial (smoke tests)
--limit-users NUMBER    Default 0 (all); nonzero ALWAYS marks output partial
--chunk-size NUMBER     Maximum log interval (default 1000000), shrinks on limits
--log-limit NUMBER      Provider log cap (default 10000); receipts fallback at one block
--batch-size NUMBER     RPC operations per batch (default 10; 1 disables batches)
--delay-ms NUMBER       Delay per HTTP request (default 200)
--preflight-only        Read/verify contract and block, without scanning users

Rerun with the same block, output directory and sample options to resume.
Exit 0: full scan and exact custody reconciliation; 2: partial or custody difference;
1: incomplete/failed. No private key required. No Ethereum recipient mapping.`);
  process.exit(0);
}
function integer(name, min = 0) {
  const text = values[name];
  if (!/^\d+$/.test(text ?? '') || !Number.isSafeInteger(Number(text)) || Number(text) < min || Number(text) >= Number.MAX_SAFE_INTEGER) throw new Error(`--${name} must be a safe integer >= ${min}`);
  return Number(text);
}
const progress = message => console.error(`[${new Date().toISOString()}] ${message}`);
function implementationHash() {
  const hash = createHash('sha256');
  for (const file of ['gravity-staking.mjs', 'lib/rpc.mjs', 'lib/store.mjs', 'lib/snapshot.mjs', 'lib/classify.mjs', 'lib/export.mjs', 'contract.json', 'package-lock.json']) hash.update(file).update(readFileSync(join(packageDir, file)));
  return hash.digest('hex');
}

async function main() {
  const block = integer('block'), fromBlock = integer('from-block'), limitUsers = integer('limit-users');
  if (fromBlock > block) throw new Error('--from-block exceeds target block');
  const options = { block, fromBlock, limitUsers, chunkSize: integer('chunk-size', 1), logLimit: integer('log-limit', 1), progress };
  const urls = [values.rpc || process.env.GRAVITY_ALPHA_RPCURL || process.env.GRAVITY_RPC_URL || 'https://rpc.gravity.xyz', values['fallback-rpc'] || process.env.GRAVITY_ALPHA_FAILOVERRPCURL || 'https://rpc.gravity.xyz'];
  const rpc = new Rpc(urls, { batchSize: integer('batch-size', 1), delay: integer('delay-ms') });
  const initial = await preflight(rpc, block);
  progress(`Verified block ${block}, hash=${initial.header.hash}, multiplier=${initial.config.multiplier}, paused=${initial.config.paused}`);
  if (values['preflight-only']) { console.log(json({ chainId: 1625, block, blockHash: initial.header.hash, config: initial.config })); return; }
  const dir = values.out ? resolve(values.out) : join(packageDir, 'output', 'gravity', String(block));
  const release = acquireLock(dir);
  let store, stage = 'init';
  const stop = signal => {
    try { store?.close(); } finally { release(); process.exit(signal === 'SIGINT' ? 130 : 143); }
  };
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const identity = { schemaVersion: 1, implementationHash: implementationHash(), chainId: 1625, contract: CONTRACT.address, block, blockHash: initial.header.hash, stateRoot: initial.header.stateRoot, fromBlock, limitUsers, abiHash: ABI_HASH };
    store = new Store(dir, identity);
    const cached = store.get('preflight');
    if (cached && json(cached.config) !== json(initial.config)) throw new Error('RPC state differs from cached snapshot configuration');
    if (!store.get('finishedAt')) {
      store.set('preflight', initial);
      stage = 'logs';
      await collectLogs(rpc, store, options);
      stage = 'positions';
      await collectPositions(rpc, store, { ...options, config: initial.config });
      stage = 'verify';
      if (!limitUsers) store.verifyCoverage();
      // Re-read config/custody and check canonical identity before sealing.
      const final = await preflight(rpc, block);
      if (json(initial.config) !== json(final.config) || final.header.hash !== initial.header.hash) throw new Error('Snapshot state changed during collection');
      const result = reconcile(store, initial.config, options);
      store.transaction(() => { store.set('result', result); store.set('finishedAt', new Date().toISOString()); store.set('status', result.status); });
    }
    const result = store.get('result');
    const report = {
      ...identity, ...result, startedAt: store.get('startedAt'), finishedAt: store.get('finishedAt'), config: initial.config,
      asset: { symbol: 'G', kind: 'native', decimals: 18 },
      events: store.count('events'), logRanges: store.count('log_ranges'),
      completeness: { fullHistoryRequested: fromBlock === 0, allUsersRequested: limitUsers === 0, throughBlock: store.get('nextBlock') - 1, source: 'historical_RPC_logs_and_state', cryptographicCompletenessProof: false },
      caveats: [
        'Full user discovery relies on complete historical RPC logs. Range coverage/custody reconciliation are not cryptographic proofs of discovery.',
        'Getter amounts are already divided by multiplier. Raw internal units are retained; custody is compared in exact internal units.',
        'Unlock status uses target-block timestamp and lockTimePeriod; maturity does not guarantee withdrawal execution or solvency.',
        'EOA means empty code at the target block, not proof of private-key control. Safe owner data applies to Gravity at this block.',
        'Source addresses are not verified Ethereum recipients. No allocation or claim tree is generated.',
        'The staking contract native balance is already part of the raw G-holder snapshot; do not add it again to user staking rights.',
        'Surplus/deficit remains unexplained until reviewed; user amounts are never adjusted to force a match.',
      ],
    };
    stage = 'export';
    const files = await writeExports(store, dir, report);
    store.close(); store = undefined;
    await sealManifest(dir, files, report);
    console.log(json({ directory: dir, status: report.status, users: report.summary.queriedUsers, activeUsers: report.summary.activeUsers, differenceInternalUnits: report.reconciliation.differenceInternalUnits }));
    process.exitCode = report.status === 'reconciled' ? 0 : 2;
  } catch (error) {
    const message = error.message.replace(/https?:\/\/\S+/g, '[endpoint]');
    if (store && !store.closed) store.recordError(stage, message);
    writeFileSync(join(dir, 'last-error.json'), json({ stage, message, at: new Date().toISOString() }) + '\n');
    throw new Error(message);
  } finally {
    store?.close(); release();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}
main().catch(error => { console.error(`Snapshot failed: ${error.message.replace(/https?:\/\/\S+/g, '[endpoint]')}`); process.exitCode = 1; });
