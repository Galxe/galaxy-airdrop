import { Trie } from '@ethereumjs/trie';
import { keccak256 } from 'ethers';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { TrieDB } from './store.mjs';
import { bytes, prefixed, EMPTY_ROOT } from './data.mjs';

export async function verifyState(store, expectedRoot, { batchSize = 1000, progress = () => {}, afterLeaf } = {}) {
  if (!store.get('sourceComplete')) throw new Error('State source not complete');
  if (store.get('verifiedRoot')) {
    if (store.get('verifiedRoot') !== expectedRoot) throw new Error('Cached verification root mismatch');
    return expectedRoot;
  }
  const trie = new Trie({ db: new TrieDB(store), valueEncoding: 'view', useKeyHashing: false, useNodePruning: true, cacheSize: 0, root: bytes(store.get('trieRoot') ?? EMPTY_ROOT) });
  let key = store.get('trieKey'), processed = store.get('trieProcessed') ?? 0;
  while (true) {
    const rows = store.pageAfter(key, batchSize);
    if (!rows.length) break;
    await store.atomicAsync(async () => {
      for (const row of rows) {
        await trie.put(row.trie_key, row.account_rlp); processed++;
        if (afterLeaf) await afterLeaf(processed);
      }
      key = prefixed(rows.at(-1).trie_key);
      store.set('trieKey', key); store.set('trieRoot', prefixed(trie.root())); store.set('trieProcessed', processed);
    });
    progress(`Verified trie leaves ${processed}/${store.get('accountCount')}`);
  }
  const actualRoot = prefixed(trie.root());
  if (processed !== store.get('accountCount') || actualRoot !== expectedRoot) throw new Error(`Account stateRoot mismatch: reconstructed=${actualRoot}, expected=${expectedRoot}`);
  const missing = store.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE balance_wei!='0' AND address IS NULL").get().n;
  if (missing) throw new Error(`${missing} positive-balance accounts have no address preimage; snapshot cannot be complete`);
  // Preimages were checked on ingestion; repeat against the persisted bytes before sealing.
  for (const row of store.db.prepare('SELECT trie_key,address FROM accounts WHERE address IS NOT NULL').iterate()) {
    if (keccak256(row.address) !== prefixed(row.trie_key)) throw new Error('Persisted address preimage mismatch');
  }
  for (const row of store.db.prepare('SELECT sha256,raw_gzip FROM chunks ORDER BY id').iterate()) {
    if (createHash('sha256').update(gunzipSync(row.raw_gzip)).digest('hex') !== row.sha256) throw new Error('Raw source evidence checksum mismatch');
  }
  store.checkIntegrity();
  store.set('verifiedRoot', actualRoot);
  return actualRoot;
}
