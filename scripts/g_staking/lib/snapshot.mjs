import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Interface, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { hex, isRangeError } from './rpc.mjs';
import { classify, loadSafeRegistry } from './classify.mjs';

export const CONTRACT = JSON.parse(readFileSync(new URL('../contract.json', import.meta.url)));
export const ABI = new Interface(CONTRACT.abi);
export const ABI_HASH = createHash('sha256').update(JSON.stringify(CONTRACT.abi)).digest('hex');
export const EVENT_NAMES = ['TokenStaked', 'TokenUnStaked', 'TokenRevokeUnStaked', 'TokenWithdraw'];
export const TOPICS = EVENT_NAMES.map(name => ABI.getEvent(name).topicHash);
const address = value => getAddress(value).toLowerCase();
const uint = value => {
  const result = BigInt(value);
  if (result < 0n || result >= 2n ** 256n) throw new Error('Invalid uint256');
  return result;
};
const number = value => {
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid block/log index');
  return n;
};
export const callSpec = (name, args, block) => ({ method: 'eth_call', params: [{ to: CONTRACT.address, data: ABI.encodeFunctionData(name, args) }, hex(block)] });
const decode = (name, value) => ABI.decodeFunctionResult(name, value);

export async function preflight(rpc, block) {
  const header = await rpc.pin(block);
  const names = ['allowedToken', 'multiplier', 'lockTimePeriod', 'paused', 'unStakeLimit'];
  const calls = names.map(name => callSpec(name, [], block));
  calls.push({ method: 'eth_getCode', params: [CONTRACT.address, hex(block)] }, { method: 'eth_getBalance', params: [CONTRACT.address, hex(block)] });
  const results = await rpc.batch(calls);
  const config = Object.fromEntries(names.map((name, i) => [name, decode(name, results[i])[0]]));
  if (address(config.allowedToken) !== ZeroAddress) throw new Error('Staking asset at target block is not native G');
  if (config.multiplier <= 0n) throw new Error('Invalid staking multiplier');
  const codeHash = keccak256(results[names.length]);
  if (codeHash !== CONTRACT.runtimeCodeHash) throw new Error('Staking runtime differs from verified GalxeStaking; review ABI/source before proceeding');
  await rpc.assertCanonical();
  return {
    header, results, config: {
      allowedToken: ZeroAddress, multiplier: config.multiplier.toString(), lockTimePeriod: config.lockTimePeriod.toString(),
      paused: config.paused, unStakeLimit: config.unStakeLimit.toString(), codeHash,
      custodyWei: uint(results[names.length + 1]).toString(), timestamp: uint(header.timestamp).toString(),
    },
  };
}

export function parseLog(log, from, to) {
  const block = number(log.blockNumber), logIndex = number(log.logIndex);
  if (address(log.address) !== CONTRACT.address || block < from || block > to || log.removed ||
      !/^0x[0-9a-f]{64}$/i.test(log.blockHash) || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash) ||
      log.topics?.length !== 2 || !TOPICS.includes(log.topics[0]?.toLowerCase())) throw new Error('Invalid or out-of-range staking log');
  const event = ABI.parseLog(log);
  const user = address(event.args.userAddress);
  if (user === ZeroAddress) throw new Error('Zero-address staking user');
  const encoded = ABI.encodeEventLog(event.fragment, event.args);
  if (encoded.data.toLowerCase() !== log.data.toLowerCase() || encoded.topics.some((topic, i) => topic.toLowerCase() !== log.topics[i].toLowerCase())) throw new Error('Noncanonical staking log encoding');
  return {
    block, blockHash: log.blockHash.toLowerCase(), txHash: log.transactionHash.toLowerCase(), logIndex,
    name: event.name, address: user, amount: (event.name === 'TokenStaked' ? event.args.amount : event.args.unStakeInfo.amount).toString(),
    unstakeTime: event.name === 'TokenStaked' ? null : event.args.unStakeInfo.unStakeTime.toString(),
  };
}

// Standard receipts provide a fallback when a single block exceeds the log cap.
export async function receiptLogs(rpc, block) {
  const header = await rpc.call('eth_getBlockByNumber', [hex(block), false]);
  if (!header || number(header.number) !== block || !Array.isArray(header.transactions)) throw new Error('Block unavailable for receipt fallback');
  const receipts = await rpc.batch(header.transactions.map(tx => ({ method: 'eth_getTransactionReceipt', params: [tx] })));
  const logs = [];
  receipts.forEach((receipt, i) => {
    if (!receipt || receipt.blockHash !== header.hash || number(receipt.blockNumber) !== block || receipt.transactionHash !== header.transactions[i] || !Array.isArray(receipt.logs)) throw new Error('Incomplete/inconsistent block receipts');
    for (const log of receipt.logs) if (log.address?.toLowerCase() === CONTRACT.address && TOPICS.includes(log.topics?.[0]?.toLowerCase())) logs.push(log);
  });
  return { logs, evidence: { kind: 'block_receipts', header, receipts } };
}

export async function collectLogs(rpc, store, { block, chunkSize, logLimit, progress = () => {} }) {
  let from = store.get('nextBlock'), step = chunkSize;
  while (from <= block) {
    const to = Math.min(block, from + step - 1);
    await rpc.assertCanonical();
    let logs, evidence;
    try {
      logs = await rpc.call('eth_getLogs', [{ address: CONTRACT.address, topics: [TOPICS], fromBlock: hex(from), toBlock: hex(to) }]);
      if (!Array.isArray(logs)) throw new Error('Invalid eth_getLogs response');
      if (logs.length >= logLimit) {
        if (from < to) { step = Math.max(1, Math.floor(step / 2)); continue; }
        ({ logs, evidence } = await receiptLogs(rpc, from));
      }
    } catch (error) {
      if (!isRangeError(error) && !/timeout|timed out/.test(error.message)) throw error;
      if (from < to) { step = Math.max(1, Math.floor(step / 2)); continue; }
      ({ logs, evidence } = await receiptLogs(rpc, from));
    }
    const parsed = logs.map(log => parseLog(log, from, to)).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    await rpc.assertCanonical();
    store.commitLogs(from, to, logs, parsed, evidence);
    from = to + 1;
    progress(`Logs through ${to}/${block}; users=${store.count('users')}, events=${store.count('events')}`);
    if (logs.length < Math.floor(logLimit / 10)) step = Math.min(chunkSize, step * 2);
  }
}

export function buildPosition(user, values, rawBatches, config) {
  const multiplier = uint(config.multiplier), timestamp = uint(config.timestamp), lock = uint(config.lockTimePeriod);
  const staked = uint(values.staked), rawStaked = uint(values.rawStaked);
  if (!multiplier || rawStaked / multiplier !== staked) throw new Error('Staking getter/internal balance mismatch');
  if (values.batches.length !== rawBatches.length || BigInt(rawBatches.length) > uint(config.unStakeLimit)) throw new Error('Unstake batch count mismatch');
  let pending = 0n, unlocked = 0n, rawTotal = rawStaked;
  const batches = values.batches.map((entry, index) => {
    const time = uint(entry.unStakeTime), amount = uint(entry.amount);
    const raw = rawBatches[index];
    if (uint(raw.unStakeTime) !== time || uint(raw.amount) / multiplier !== amount || time > timestamp) throw new Error('Unstake getter/internal batch mismatch');
    const unlock = time + lock;
    if (unlock >= 2n ** 256n) throw new Error('Unstake unlock timestamp overflow');
    const matured = timestamp >= unlock;
    if (matured) unlocked += amount; else pending += amount;
    rawTotal += uint(raw.amount);
    return { index, unstakeTime: time.toString(), unlockTime: unlock.toString(), amountWei: amount.toString(), internalUnits: uint(raw.amount).toString(), roundingRemainderUnits: (uint(raw.amount) % multiplier).toString(), matured };
  });
  return {
    address: address(user), stakedWei: staked.toString(), pendingWei: pending.toString(), unlockedWei: unlocked.toString(),
    totalPositionWei: (staked + pending + unlocked).toString(), rawStakedUnits: rawStaked.toString(), internalUnits: rawTotal.toString(),
    stakedRoundingRemainderUnits: (rawStaked % multiplier).toString(),
    hasPosition: rawTotal > 0n, batches,
    // A maturity indicator, not a guarantee of a successful transaction/solvency.
    hasMaturedBatch: batches.some(batch => batch.matured), paused: config.paused,
  };
}

export async function collectPositions(rpc, store, { block, config, limitUsers = 0, progress = () => {}, registryLoader = loadSafeRegistry, classifier = classify }) {
  const recorder = evidence => ({ call: async (method, params) => {
    try { const result = await rpc.call(method, params); evidence.push({ method, params, result }); return result; }
    catch (error) { evidence.push({ method, params, error: { code: error.code ?? null } }); throw error; }
  } });
  const registryEvidence = [];
  const registry = await registryLoader(recorder(registryEvidence), block);
  store.set('safeRegistry', { proxyHashes: [...registry.proxyHashes].sort(), implementationHashes: [...registry.implementationHashes].sort() });
  store.set('safeRegistryEvidence', registryEvidence);
  while (true) {
    const remaining = limitUsers ? limitUsers - store.count('positions') : 100;
    if (remaining <= 0) break;
    const users = store.pendingUsers(Math.min(20, remaining));
    if (!users.length) break;
    await rpc.assertCanonical();
    const prepared = [];
    for (const user of users) {
      const results = await rpc.batch([
        callSpec('getStakeAmount', [user], block), callSpec('balances', [user], block), callSpec('getUnStakeInfo', [user], block),
        { method: 'eth_getCode', params: [user, hex(block)] },
      ]);
      const values = { staked: decode('getStakeAmount', results[0])[0], rawStaked: decode('balances', results[1])[0], batches: decode('getUnStakeInfo', results[2])[0] };
      const batchResponses = await rpc.batch(values.batches.map((_, i) => callSpec('unStakeInfoMap', [user, i], block)));
      const rawBatches = batchResponses.map(result => decode('unStakeInfoMap', result));
      const row = buildPosition(user, values, rawBatches, config);
      const classificationEvidence = [];
      Object.assign(row, await classifier(recorder(classificationEvidence), user, results[3], block, registry));
      row.codeHash = keccak256(results[3]);
      prepared.push({ row, evidence: { results, batchResponses, classificationEvidence } });
    }
    await rpc.assertCanonical();
    store.commitPositions(prepared);
    progress(`User states ${store.count('positions')}/${store.count('users')}`);
  }
}

export function reconcile(store, config, { fromBlock, limitUsers }) {
  const summary = { historicalUsers: store.count('users'), queriedUsers: store.count('positions'), activeUsers: 0, stakedWei: 0n, pendingWei: 0n, unlockedWei: 0n, internalUnits: 0n, byType: {} };
  for (const row of store.rows()) {
    if (row.hasPosition) summary.activeUsers++;
    for (const key of ['stakedWei', 'pendingWei', 'unlockedWei', 'internalUnits']) summary[key] += BigInt(row[key]);
    const type = summary.byType[row.type] ??= { users: 0, activeUsers: 0, positionWei: 0n };
    type.users++;
    if (row.hasPosition) type.activeUsers++;
    type.positionWei += BigInt(row.totalPositionWei);
  }
  const multiplier = BigInt(config.multiplier);
  const differenceUnits = BigInt(config.custodyWei) * multiplier - summary.internalUnits;
  const partial = fromBlock !== 0 || limitUsers !== 0 || summary.historicalUsers !== summary.queriedUsers;
  const status = partial ? 'partial' : differenceUnits === 0n ? 'reconciled' : differenceUnits > 0n ? 'custody_surplus' : 'custody_deficit';
  return {
    status, summary,
    reconciliation: {
      custodyWei: config.custodyWei, liabilityInternalUnits: summary.internalUnits, multiplier: config.multiplier,
      liabilityWeiFloor: summary.internalUnits / multiplier, liabilityRemainderUnits: summary.internalUnits % multiplier,
      differenceInternalUnits: differenceUnits, differenceWeiTruncated: differenceUnits / multiplier,
      differenceRemainderUnits: differenceUnits % multiplier,
      matched: differenceUnits === 0n,
    },
  };
}
