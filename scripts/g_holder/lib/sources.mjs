import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse, json, hash, normalizeAccount, validatePage } from './data.mjs';

export async function fileSha256(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

// Checkpoint byte offsets, including CRLF and a last line without a newline.
export async function* lines(path, start = 0) {
  let carry = Buffer.alloc(0), offset = start;
  for await (const chunk of createReadStream(path, { start })) {
    carry = Buffer.concat([carry, chunk]);
    let newline;
    while ((newline = carry.indexOf(10)) !== -1) {
      if (newline > 2 * 1024 * 1024) throw new Error('State JSONL line exceeds 2 MiB; omit code and storage payloads');
      const raw = carry.subarray(0, newline + 1); offset += raw.length;
      yield { raw: Buffer.from(raw), text: raw.toString('utf8').trim(), end: offset };
      carry = carry.subarray(newline + 1);
    }
    if (carry.length > 2 * 1024 * 1024) throw new Error('State JSONL line exceeds 2 MiB');
  }
  if (carry.length) yield { raw: carry, text: carry.toString('utf8').trim(), end: offset + carry.length };
}

export async function inspectFile(path, identity) {
  const iterator = lines(path);
  let first;
  try { first = (await iterator.next()).value; } finally { await iterator.return(); }
  if (!first?.text) throw new Error('Missing state file header');
  const header = parse(first.text);
  if (hash(header.stateRoot ?? header.root) !== identity.stateRoot) throw new Error('State file header root differs from target block');
  if (header.format !== undefined) {
    if (header.format !== 'gravity-native-state-v1' || String(header.chainId) !== '1625' || String(header.block) !== String(identity.block) || hash(header.blockHash) !== identity.blockHash) throw new Error('State file header snapshot identity mismatch');
  } else if (Object.keys(header).length !== 1 || !header.root) throw new Error('Expected canonical snapshot header or Geth iterative dump root');
  return { header, end: first.end, sha256: await fileSha256(path) };
}

export async function collectFile(store, path, info, { pageSize, progress = () => {} }) {
  if (store.get('sourceComplete')) return;
  let offset = store.get('fileOffset') || info.end;
  let accounts = [], raw = [];
  for await (const line of lines(path, offset)) {
    if (!line.text) throw new Error('Blank state account line');
    accounts.push(normalizeAccount(parse(line.text))); raw.push(line.raw); offset = line.end;
    if (accounts.length >= pageSize) {
      store.commitChunk(accounts, Buffer.concat(raw), { fileOffset: offset }); accounts = []; raw = [];
      progress(`Imported ${store.get('accountCount')} accounts; byte=${offset}`);
    }
  }
  if (accounts.length) store.commitChunk(accounts, Buffer.concat(raw), { fileOffset: offset });
  if (await fileSha256(path) !== info.sha256) throw new Error('State file changed while collecting');
  store.set('sourceComplete', true);
}

export const accountRangeParams = (identity, cursor, pageSize) => [
  { blockHash: identity.blockHash, requireCanonical: true }, cursor, pageSize,
  true, // nocode
  true, // nostorage: account.storageRoot is still included
  true, // incompletes: KEEP leaves without address preimages
];

export async function probeStateRpc(rpc, identity, pageSize) {
  const header = await rpc.pin(identity.block);
  if (header.hash !== identity.blockHash || hash(header.stateRoot) !== identity.stateRoot) throw new Error('State RPC snapshot identity mismatch');
  try {
    const page = await rpc.call('debug_accountRange', accountRangeParams(identity, '0x', pageSize));
    validatePage(page, '0x', identity.stateRoot, pageSize);
    return { page, raw: rpc.lastResponseText };
  } catch (error) {
    throw new Error(`Full account source unavailable: ${error.message}. Supply a state RPC with debug_accountRange or a complete state JSONL file.`);
  }
}

export async function collectRpc(store, rpc, identity, { pageSize, progress = () => {}, firstPage }) {
  if (store.get('sourceComplete')) return;
  let cursor = store.get('cursor');
  while (cursor !== null) {
    await rpc.assertCanonical();
    let page, raw;
    if (cursor === '0x' && firstPage) { ({ page, raw } = firstPage); firstPage = null; }
    else { page = await rpc.call('debug_accountRange', accountRangeParams(identity, cursor, pageSize)); raw = rpc.lastResponseText; }
    const result = validatePage(page, cursor, identity.stateRoot, pageSize);
    await rpc.assertCanonical();
    store.commitChunk(result.accounts, raw ?? json(page), { cursor: result.next, sourceComplete: result.next === null });
    cursor = result.next;
    progress(`Imported ${store.get('accountCount')} accounts; cursor=${cursor ?? 'end'}`);
  }
}
