import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { formatUnits } from 'ethers';
import { json } from './store.mjs';

// Quoting alone does not stop spreadsheet formulas in untrusted contract text.
const csv = values => values.map(value => {
  let text = String(value ?? '');
  if (/^[\t\r\n]|^\s*[=+@-]/u.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}).join(',') + '\n';
const columns = ['snapshot_status', 'source_chain_id', 'block', 'source_address', 'address_type', 'has_position', 'staked_wei', 'pending_wei', 'unlocked_wei', 'total_position_wei', 'total_position_g', 'internal_units', 'multiplier', 'paused', 'has_matured_batch', 'code_hash', 'safe_verified', 'safe_version', 'safe_threshold', 'safe_owners', 'delegation'];
const rowValues = (row, report) => [report.status, 1625, report.block, row.address, row.type, row.hasPosition, row.stakedWei, row.pendingWei, row.unlockedWei, row.totalPositionWei, formatUnits(row.totalPositionWei, 18), row.internalUnits, report.config.multiplier, row.paused, row.hasMaturedBatch, row.codeHash, row.safe?.verified, row.safe?.version, row.safe?.threshold, row.safe?.owners.join(';'), row.delegation];

export async function writeExports(store, dir, report) {
  const folder = join(dir, 'exports');
  await mkdir(folder, { recursive: true });
  const names = ['stakers.csv', 'stakers.active.csv', 'stakers.eoa.csv', 'stakers.contract.csv', 'stakers.delegated.csv', 'stakers.special.csv', 'unstake-batches.csv', 'stakers.jsonl'];
  const streams = new Map(names.map(name => [name, createWriteStream(join(folder, `${name}.tmp`))]));
  let failure;
  for (const stream of streams.values()) stream.on('error', error => { failure ??= error; });
  const append = async (name, value) => {
    if (failure) throw failure;
    if (!streams.get(name).write(value)) await once(streams.get(name), 'drain');
  };
  try {
    for (const name of names.filter(name => name.startsWith('stakers') && name.endsWith('.csv'))) await append(name, csv(columns));
    await append('unstake-batches.csv', csv(['snapshot_status', 'source_address', 'batch_index', 'unstake_time', 'unlock_time', 'amount_wei', 'internal_units', 'rounding_remainder_units', 'matured', 'paused']));
    for (const row of store.rows()) {
      const line = csv(rowValues(row, report));
      await append('stakers.csv', line);
      if (row.hasPosition) await append('stakers.active.csv', line);
      const group = { EOA: 'eoa', EOA_DELEGATED: 'delegated', CONTRACT: 'contract', SAFE: 'contract', SPECIAL: 'special' }[row.type];
      if (!group) throw new Error('Unknown address classification');
      await append(`stakers.${group}.csv`, line);
      await append('stakers.jsonl', json({ snapshotStatus: report.status, chainId: 1625, block: report.block, ...row }) + '\n');
      for (const batch of row.batches) await append('unstake-batches.csv', csv([report.status, row.address, batch.index, batch.unstakeTime, batch.unlockTime, batch.amountWei, batch.internalUnits, batch.roundingRemainderUnits, batch.matured, row.paused]));
    }
    await Promise.all([...streams.values()].map(stream => new Promise((resolve, reject) => {
      if (stream.errored) return reject(stream.errored);
      stream.once('error', reject);
      stream.end(resolve);
    })));
    if (failure) throw failure;
    for (const name of names) await rename(join(folder, `${name}.tmp`), join(folder, name));
    await writeFile(join(dir, 'report.json.tmp'), json(report) + '\n');
    await rename(join(dir, 'report.json.tmp'), join(dir, 'report.json'));
    return [...names.map(name => `exports/${name}`), 'report.json', 'snapshot.sqlite'];
  } catch (error) { for (const stream of streams.values()) stream.destroy(); throw error; }
}

export async function sealManifest(dir, files, report) {
  const checksums = {};
  for (const file of files.sort()) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(dir, file))) hash.update(chunk);
    checksums[file] = hash.digest('hex');
  }
  const manifest = {
    schemaVersion: 1, chainId: 1625, block: report.block, blockHash: report.blockHash,
    status: report.status, sourceAddressField: 'source_address', ethereumRecipientsAssigned: false,
    implementationHash: report.implementationHash, finishedAt: report.finishedAt, files: checksums,
  };
  const body = json(manifest) + '\n';
  await writeFile(join(dir, 'manifest.json.tmp'), body);
  await rename(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));
  checksums['manifest.json'] = createHash('sha256').update(body).digest('hex');
  await writeFile(join(dir, 'SHA256SUMS.tmp'), Object.keys(checksums).sort().map(file => `${checksums[file]}  ${file}\n`).join(''));
  await rename(join(dir, 'SHA256SUMS.tmp'), join(dir, 'SHA256SUMS'));
}
