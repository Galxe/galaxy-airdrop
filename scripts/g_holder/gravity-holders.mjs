#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Rpc } from './lib/rpc.mjs';
import { Store } from './lib/store.mjs';
import { acquireLock } from './lib/lock.mjs';
import { hash, json, uint } from './lib/data.mjs';
import { inspectFile, probeStateRpc, collectFile, collectRpc } from './lib/sources.mjs';
import { verifyState } from './lib/verify.mjs';
import { classifyHolders, summarize } from './lib/holders.mjs';
import { readBridge } from './lib/bridge.mjs';
import { writeExports, sealManifest } from './lib/export.mjs';

const packageDir = fileURLToPath(new URL('.', import.meta.url));
const { values } = parseArgs({ options: {
  block: { type: 'string' }, mode: { type: 'string', default: 'rpc-state' }, 'state-file': { type: 'string' }, 'state-rpc': { type: 'string' },
  rpc: { type: 'string' }, 'fallback-rpc': { type: 'string' }, out: { type: 'string' },
  'page-size': { type: 'string', default: '256' }, 'batch-size': { type: 'string', default: '10' }, 'delay-ms': { type: 'string', default: '200' },
  'verify-batch-size': { type: 'string', default: '1000' }, 'safe-info': { type: 'boolean' }, 'preflight-only': { type: 'boolean' },
  'ethereum-rpc': { type: 'string' }, 'ethereum-block': { type: 'string' }, 'bridge-adjustments': { type: 'string' }, help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log(`Gravity Alpha native-G holder snapshot (Node >=22.13)

npm run snapshot:holders -- --block NUMBER --mode rpc-state --state-rpc URL
npm run snapshot:holders -- --block NUMBER --mode state-file --state-file dump.jsonl

--rpc / --fallback-rpc      Production read RPCs, or GRAVITY_ALPHA_RPCURL / GRAVITY_ALPHA_FAILOVERRPCURL
--state-rpc                debug_accountRange endpoint, or GRAVITY_SNAPSHOT_STATE_RPCURL
--out RUN_DIRECTORY        Default scripts/g_holder/output/gravity/<block>
--page-size NUMBER         Accounts per import batch (default/max 256 for RPC)
--batch-size NUMBER        RPC operations per request (default 10; 1 disables batches)
--delay-ms NUMBER          Delay per HTTP request (default 200)
--verify-batch-size NUMBER Trie leaves per durable checkpoint (default 1000)
--safe-info                Also inspect recognized Safe proxies at B (additional RPC reads)
--preflight-only           Verify input/RPC capability without collecting a snapshot
--ethereum-block NUMBER    Optional fixed Ethereum escrow comparison block
--ethereum-rpc URL         Required with Ethereum block (or ETHEREUM_RPCURL)
--bridge-adjustments FILE  Optional adjustment ledger tied to both block hashes

Same command and run directory resume committed work. Source changes require a new directory.
No public-holder-list fallback. All state accounts, including zero balances, are required.
Exit 0: state/address checks passed and any requested bridge comparison has an adjusted match;
2: state verified but requested bridge reconciliation unresolved; 1: incomplete/error.
Preflight success also exits 0, without producing a snapshot.`);
  process.exit(0);
}
function integer(name, min = 0) {
  const text = values[name];
  if (!/^\d+$/.test(text ?? '') || !Number.isSafeInteger(Number(text)) || Number(text) < min || Number(text) >= Number.MAX_SAFE_INTEGER) throw new Error(`--${name} must be a safe integer >= ${min}`);
  return Number(text);
}
const digest = text => createHash('sha256').update(text).digest('hex');
function implementationHash() {
  const files = ['gravity-holders.mjs', 'package-lock.json', ...readdirSync(join(packageDir, 'lib')).filter(name => name.endsWith('.mjs')).map(name => 'lib/' + name)].sort();
  const hash = createHash('sha256'); for (const file of files) hash.update(file).update(readFileSync(join(packageDir, file))); return hash.digest('hex');
}
const progress = message => console.error(`[${new Date().toISOString()}] ${message}`);

async function main() {
  const block = integer('block'), pageSize = integer('page-size', 1), verifyBatchSize = integer('verify-batch-size', 1);
  if (!['rpc-state', 'state-file'].includes(values.mode)) throw new Error('Unknown source mode');
  if (values.mode === 'rpc-state' && pageSize > 256) throw new Error('Nitro debug_accountRange caps page size at 256');
  if (values.mode === 'state-file' && !values['state-file']) throw new Error('--state-file is required');
  if (values.mode === 'rpc-state' && values['state-file']) throw new Error('--state-file requires --mode state-file');
  const ethereumBlock = values['ethereum-block'] === undefined ? null : integer('ethereum-block');
  const ethereumUrl = values['ethereum-rpc'] || process.env.ETHEREUM_RPCURL;
  if (ethereumBlock !== null && !ethereumUrl) throw new Error('Ethereum RPC required with --ethereum-block');
  if ((values['ethereum-rpc'] || values['bridge-adjustments']) && ethereumBlock === null) throw new Error('--ethereum-block required for bridge comparison');
  const ledgerText = values['bridge-adjustments'] ? readFileSync(resolve(values['bridge-adjustments']), 'utf8') : null;
  const rpcOptions = { batchSize: integer('batch-size', 1), delay: integer('delay-ms') };
  const urls = [values.rpc || process.env.GRAVITY_ALPHA_RPCURL || process.env.GRAVITY_RPC_URL || 'https://rpc.gravity.xyz', values['fallback-rpc'] || process.env.GRAVITY_ALPHA_FAILOVERRPCURL || 'https://rpc.gravity.xyz'];
  const rpc = new Rpc(urls, rpcOptions), header = await rpc.pin(block);
  const base = { schemaVersion: 1, chainId: 1625, block, blockHash: hash(header.hash), stateRoot: hash(header.stateRoot), timestamp: uint(header.timestamp) };
  let fileInfo, stateRpc, firstPage;
  if (values.mode === 'state-file') { progress('Checking state file header and SHA-256'); fileInfo = await inspectFile(resolve(values['state-file']), base); }
  else {
    stateRpc = new Rpc([values['state-rpc'] || process.env.GRAVITY_SNAPSHOT_STATE_RPCURL || urls[0]], rpcOptions);
    firstPage = await probeStateRpc(stateRpc, base, pageSize);
  }
  await rpc.assertCanonical();
  progress(`Preflight passed: chain=1625 block=${block} stateRoot=${base.stateRoot} source=${values.mode}`);
  if (values['preflight-only']) { console.log(json({ ...base, sourceMode: values.mode, stateFileSha256: fileInfo?.sha256 })); return; }
  const identity = { ...base, implementationHash: implementationHash(), source: { mode: values.mode, ...(fileInfo ? { sha256: fileInfo.sha256 } : {}) }, safeInfo: Boolean(values['safe-info']), bridge: { ethereumBlock, ledgerSha256: ledgerText === null ? null : digest(ledgerText) } };
  const dir = values.out ? resolve(values.out) : join(packageDir, 'output', 'gravity', String(block));
  const release = acquireLock(dir); let store, stage = 'init';
  const stop = code => { try { store?.close(); } finally { release(); process.exit(code); } };
  const interrupt = () => stop(130), terminate = () => stop(143);
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    store = new Store(dir, identity);
    if (!store.get('finishedAt')) {
      store.set('blockHeader', header);
      if (fileInfo) store.set('sourceHeader', fileInfo.header);
      stage = 'collect';
      if (fileInfo) await collectFile(store, resolve(values['state-file']), fileInfo, { pageSize, progress });
      else await collectRpc(store, stateRpc, base, { pageSize, progress, firstPage });
      await rpc.assertCanonical(); store.finishImport();
      stage = 'verify';
      await verifyState(store, base.stateRoot, { batchSize: verifyBatchSize, progress });
      stage = 'classify';
      await classifyHolders(store, rpc, { block, safeInfo: identity.safeInfo, progress });
      const summary = summarize(store);
      stage = 'bridge';
      const bridge = ethereumBlock === null ? { status: 'not_requested' } : await readBridge(new Rpc([ethereumUrl], { ...rpcOptions, chainId: 1 }), ethereumBlock, base, summary.nativeBalanceWei, ledgerText);
      await rpc.assertCanonical(); if (stateRpc) await stateRpc.assertCanonical();
      store.atomic(() => { store.set('summary', summary); store.set('bridge', bridge); store.set('finishedAt', new Date().toISOString()); });
    }
    // Recheck historical Ethereum identity when reopening a previously completed run.
    const bridge = store.get('bridge');
    if (bridge.ethereum) {
      const eth = new Rpc([ethereumUrl], { ...rpcOptions, chainId: 1 }), latest = await eth.pin(ethereumBlock);
      if (latest.hash !== bridge.ethereum.blockHash) throw new Error('Ethereum snapshot block hash changed');
    }
    const report = {
      ...identity, status: 'state_verified', verifiedRoot: store.get('verifiedRoot'), holderSnapshotComplete: true,
      startedAt: store.get('startedAt'), finishedAt: store.get('finishedAt'), summary: store.get('summary'), bridgeInputs: identity.bridge, bridge,
      asset: { kind: 'native', symbol: 'G', decimals: 18 }, ethereumRecipientsAssigned: false,
      caveats: [
        'Completeness is checked by reconstructing the account trie against the RPC block stateRoot, retaining zero-balance leaves; positive accounts must have verified address preimages.',
        'Native balances of staking, WG, bridge and other contracts are retained. WG token balances and internal staking rights are not added.',
        'EOA means empty code at the snapshot. Reserved addresses and EIP-7702-format delegation are classified separately; this does not prove private-key control.',
        'Safe inspection is optional and only covers recognized proxy code; no Ethereum recipient control is inferred.',
        'A bridge raw difference includes in-flight messages and possible surplus/protocol adjustments. A supplied ledger is checked arithmetically, not independently proven.',
      ],
    };
    stage = 'export'; const files = await writeExports(store, dir, report);
    store.close(); store = undefined;
    await sealManifest(dir, files, report);
    console.log(json({ directory: dir, status: report.status, accounts: report.summary.stateAccounts, holders: report.summary.holders, nativeBalanceWei: report.summary.nativeBalanceWei, bridgeStatus: bridge.status }));
    process.exitCode = ['not_requested', 'adjusted_match'].includes(bridge.status) ? 0 : 2;
  } catch (error) {
    const message = error.message.replace(/https?:\/\/\S+/g, '[endpoint]');
    store?.db.prepare('INSERT INTO errors(time,stage,message) VALUES(?,?,?)').run(new Date().toISOString(), stage, message);
    writeFileSync(join(dir, 'last-error.json'), json({ stage, message, at: new Date().toISOString() }) + '\n');
    throw new Error(message);
  } finally {
    store?.close(); release(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}
main().catch(error => { console.error(`Snapshot failed: ${error.message.replace(/https?:\/\/\S+/g, '[endpoint]')}`); process.exitCode = 1; });
