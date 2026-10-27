import JSONbig from 'json-bigint';
import { getAddress, keccak256, encodeRlp, toBeHex } from 'ethers';
export const parse = JSONbig({ storeAsString: true, strict: true, protoAction: 'error', constructorAction: 'error' }).parse;
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export const EMPTY_CODE = keccak256('0x');
export const EMPTY_ROOT = keccak256(encodeRlp('0x'));
export const hash = value => {
  if (typeof value !== 'string' || !/^(0x)?[0-9a-f]{64}$/i.test(value)) throw new Error('Expected 32-byte hash');
  return '0x' + value.replace(/^0x/i, '').toLowerCase();
};
export function uint(value, bits = 256) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Unsafe JSON integer');
  } else if (typeof value !== 'string' || !/^(0|[1-9][0-9]*|0x[0-9a-f]+)$/i.test(value)) throw new Error('Invalid unsigned integer');
  const n = BigInt(value);
  if (n >= 2n ** BigInt(bits)) throw new Error('Integer overflow');
  return n.toString();
}
export const bytes = value => Buffer.from(value.slice(2), 'hex');
export const prefixed = value => '0x' + Buffer.from(value).toString('hex');

export function normalizeAccount(row, mapKey) {
  if (!row || typeof row !== 'object') throw new Error('Invalid state account');
  let address = row.address ?? (/^0x[0-9a-f]{40}$/i.test(mapKey ?? '') ? mapKey : null);
  if (address !== null) address = getAddress(address).toLowerCase();
  if (/^0x[0-9a-f]{40}$/i.test(mapKey ?? '') && address !== mapKey.toLowerCase()) throw new Error('Account address disagrees with map key');
  const trieKey = hash(row.trieKey ?? row.key ?? (address === null ? undefined : keccak256(address)));
  if (address !== null && keccak256(address) !== trieKey) throw new Error('Address preimage does not match trie key');
  const nonce = uint(row.nonce, 64), balanceWei = uint(row.balanceWei ?? row.balance);
  const storageRoot = hash(row.storageRoot ?? row.root), codeHash = hash(row.codeHash);
  const quantity = n => n === '0' ? '0x' : toBeHex(BigInt(n));
  const accountRlp = encodeRlp([quantity(nonce), quantity(balanceWei), storageRoot, codeHash]);
  if (row.accountRlp && row.accountRlp.toLowerCase() !== accountRlp) throw new Error('Account RLP mismatch');
  return { trieKey, address, nonce, balanceWei, storageRoot, codeHash, accountRlp };
}

export function decodeCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  if (/^0x[0-9a-f]{64}$/i.test(value)) return hash(value);
  // Nitro/Geth Dump.Next is []byte, marshalled as standard Base64, NOT hexutil.Bytes.
  if (typeof value !== 'string') throw new Error('Invalid account cursor');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw new Error('Invalid Base64 account cursor');
  return prefixed(decoded);
}

export function validatePage(page, cursor, stateRoot, pageSize) {
  if (!page || hash(page.root) !== stateRoot || !page.accounts || Array.isArray(page.accounts) || typeof page.accounts !== 'object') throw new Error('Invalid account page or state root');
  const accounts = Object.entries(page.accounts).map(([key, value]) => normalizeAccount(value, key)).sort((a, b) => a.trieKey.localeCompare(b.trieKey));
  if (accounts.length > pageSize) throw new Error('Account page exceeds requested size');
  const next = decodeCursor(page.next);
  for (let i = 0; i < accounts.length; i++) {
    if ((cursor !== '0x' && accounts[i].trieKey < cursor) || (i && accounts[i].trieKey <= accounts[i - 1].trieKey)) throw new Error('Unordered, duplicate or out-of-range account page');
  }
  if (next && (!accounts.length || next <= accounts.at(-1).trieKey || (cursor !== '0x' && next <= cursor))) throw new Error('Account cursor did not advance');
  return { accounts, next };
}
