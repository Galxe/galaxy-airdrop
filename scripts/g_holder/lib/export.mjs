import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { formatUnits } from 'ethers';
import { holderType } from './holders.mjs';
import { json } from './data.mjs';

const csv = values => values.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',') + '\n';
export async function writeExports(store, dir, report) {
  if (!store.get('verifiedRoot') || !store.get('classificationsComplete')) throw new Error('Verified full state and complete classification are required before exporting holders');
  const folder = join(dir, 'exports'); await mkdir(folder, { recursive: true });
  const names = ['holders.all.csv', 'holders.eoa.csv', 'holders.contract.csv', 'holders.delegated.csv', 'holders.special.csv', 'holders.jsonl'];
  const streams = new Map(names.map(name => [name, createWriteStream(join(folder, name + '.tmp'))]));
  let failure;
  for (const stream of streams.values()) stream.on('error', error => { failure ??= error; });
  const append = async (name, text) => { if (failure) throw failure; if (!streams.get(name).write(text)) await once(streams.get(name), 'drain'); };
  try {
    const columns = ['snapshot_status', 'chain_id', 'block', 'source_address', 'balance_wei', 'balance_g', 'address_type', 'code_hash', 'nonce', 'delegation', 'safe_verified', 'safe_version', 'safe_threshold', 'safe_owners'];
    for (const name of names.filter(name => name.endsWith('.csv'))) await append(name, csv(columns));
    for (const row of store.holders()) {
      const type = holderType(row), safe = row.classification?.safe;
      const line = csv([report.status, 1625, report.block, row.address, row.balanceWei, formatUnits(row.balanceWei, 18), type, row.codeHash, row.nonce, row.delegation, safe?.verified, safe?.version, safe?.threshold, safe?.owners?.join(';')]);
      await append('holders.all.csv', line);
      const group = { EOA: 'eoa', CONTRACT: 'contract', SAFE: 'contract', EOA_DELEGATED: 'delegated', SPECIAL: 'special' }[type];
      await append(`holders.${group}.csv`, line);
      await append('holders.jsonl', json({ status: report.status, chainId: 1625, block: report.block, sourceAddress: row.address, balanceWei: row.balanceWei, nonce: row.nonce, codeHash: row.codeHash, type, delegation: row.delegation, safe }) + '\n');
    }
    await Promise.all([...streams.values()].map(stream => new Promise((resolve, reject) => {
      if (stream.errored) return reject(stream.errored); stream.once('error', reject); stream.end(resolve);
    })));
    if (failure) throw failure;
    for (const name of names) await rename(join(folder, name + '.tmp'), join(folder, name));
    await writeFile(join(dir, 'report.json.tmp'), json(report) + '\n');
    await rename(join(dir, 'report.json.tmp'), join(dir, 'report.json'));
    return [...names.map(name => `exports/${name}`), 'report.json', 'snapshot.sqlite'];
  } catch (error) { for (const stream of streams.values()) stream.destroy(); throw error; }
}

export async function sealManifest(dir, files, report) {
  const checksums = {};
  for (const file of files.sort()) {
    const hash = createHash('sha256'); for await (const chunk of createReadStream(join(dir, file))) hash.update(chunk);
    checksums[file] = hash.digest('hex');
  }
  const body = json({ format: 'gravity-native-holders-v1', chainId: 1625, block: report.block, blockHash: report.blockHash, stateRoot: report.stateRoot, verifiedRoot: report.verifiedRoot, status: report.status, bridgeStatus: report.bridge.status, source: report.source, implementationHash: report.implementationHash, ethereumRecipientsAssigned: false, files: checksums }) + '\n';
  await writeFile(join(dir, 'manifest.json.tmp'), body); await rename(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));
  checksums['manifest.json'] = createHash('sha256').update(body).digest('hex');
  await writeFile(join(dir, 'SHA256SUMS.tmp'), Object.keys(checksums).sort().map(file => `${checksums[file]}  ${file}\n`).join(''));
  await rename(join(dir, 'SHA256SUMS.tmp'), join(dir, 'SHA256SUMS'));
}
