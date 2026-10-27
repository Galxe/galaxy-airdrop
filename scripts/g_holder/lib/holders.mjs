import { keccak256 } from 'ethers';
import { EMPTY_CODE, bytes, prefixed, json, uint } from './data.mjs';
import { hex } from './rpc.mjs';
import { classify, loadSafeRegistry } from './classify.mjs';

export function reserved(address) {
  const n = BigInt(address);
  return n === 0n || (n >= 1n && n <= 10n) || (n >= 100n && n <= 114n) || n === 255n;
}
export function holderType(row) {
  if (!row.address) throw new Error('Missing positive account address');
  if (reserved(row.address)) return 'SPECIAL';
  if (row.codeHash === EMPTY_CODE) return 'EOA';
  if (row.codeKind === 'EOA_DELEGATED') return 'EOA_DELEGATED';
  if (row.codeKind !== 'CONTRACT') throw new Error('Missing account code classification');
  return row.classification?.type === 'SAFE' ? 'SAFE' : 'CONTRACT';
}

const recording = (rpc, evidence) => ({ call: async (method, params) => {
  try { const result = await rpc.call(method, params); evidence.push({ method, params, result }); return result; }
  catch (error) { evidence.push({ method, params, error: { code: error.code ?? null } }); throw error; }
} });

export async function classifyHolders(store, rpc, { block, safeInfo = false, progress = () => {} }) {
  if (!store.get('verifiedRoot')) throw new Error('Verify state root before classifying holders');
  const missing = store.db.prepare("SELECT a.code_hash,MIN(a.address) AS address FROM accounts a LEFT JOIN codes c ON a.code_hash=c.code_hash WHERE a.balance_wei!='0' AND a.code_hash!=? AND c.code_hash IS NULL GROUP BY a.code_hash ORDER BY a.code_hash LIMIT 100");
  const insert = store.db.prepare('INSERT INTO codes VALUES(?,?,?,?,?)');
  while (true) {
    const rows = missing.all(bytes(EMPTY_CODE));
    if (!rows.length) break;
    await rpc.assertCanonical();
    const codes = await rpc.batch(rows.map(row => ({ method: 'eth_getCode', params: [prefixed(row.address), hex(block)] })));
    await rpc.assertCanonical();
    store.atomic(() => {
      rows.forEach((row, i) => {
        const code = codes[i];
        if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code) || keccak256(code) !== prefixed(row.code_hash)) throw new Error('RPC bytecode does not match verified account codeHash');
        const delegated = /^0xef0100[0-9a-f]{40}$/i.test(code);
        insert.run(row.code_hash, row.address, code, delegated ? 'EOA_DELEGATED' : 'CONTRACT', delegated ? '0x' + code.slice(8).toLowerCase() : null);
      });
    });
    progress(`Resolved ${store.db.prepare('SELECT COUNT(*) AS n FROM codes').get().n} distinct code hashes`);
  }
  if (safeInfo) {
    const evidence = [], registry = await loadSafeRegistry(recording(rpc, evidence), block);
    store.set('safeRegistry', { proxyHashes: [...registry.proxyHashes], implementations: [...registry.implementationHashes], evidence });
    const hashes = [...registry.proxyHashes].map(bytes);
    if (hashes.length) {
      const query = store.db.prepare(`SELECT a.address,c.code FROM accounts a JOIN codes c ON a.code_hash=c.code_hash LEFT JOIN classifications s ON a.address=s.address WHERE a.balance_wei!='0' AND a.code_hash IN (${hashes.map(() => '?').join(',')}) AND s.address IS NULL ORDER BY a.address LIMIT 50`);
      while (true) {
        const rows = query.all(...hashes); if (!rows.length) break;
        const result = [];
        await rpc.assertCanonical();
        for (const row of rows) {
          const calls = [], payload = await classify(recording(rpc, calls), prefixed(row.address), row.code, block, registry);
          result.push({ address: row.address, payload, calls });
        }
        await rpc.assertCanonical();
        store.atomic(() => { for (const row of result) store.db.prepare('INSERT INTO classifications VALUES(?,?,?)').run(row.address, json(row.payload), json(row.calls)); });
        progress(`Inspected ${store.db.prepare('SELECT COUNT(*) AS n FROM classifications').get().n} Safe proxy accounts`);
      }
    }
  }
  // Deterministic spot checks against the production read RPC, including code-free accounts.
  const samples = store.db.prepare('SELECT address,balance_wei,code_hash FROM accounts WHERE address IS NOT NULL ORDER BY trie_key LIMIT 8').all();
  const calls = samples.flatMap(row => [
    { method: 'eth_getBalance', params: [prefixed(row.address), hex(block)] },
    { method: 'eth_getCode', params: [prefixed(row.address), hex(block)] },
  ]);
  const values = await rpc.batch(calls);
  samples.forEach((row, i) => {
    if (uint(values[2 * i]) !== row.balance_wei || keccak256(values[2 * i + 1]) !== prefixed(row.code_hash)) throw new Error('Production RPC account spot check mismatch');
  });
  await rpc.assertCanonical();
  store.set('spotChecks', samples.map((row, i) => ({ address: prefixed(row.address), balance: values[2 * i], code: values[2 * i + 1] })));
  store.set('classificationsComplete', true);
}

export function summarize(store) {
  let nativeBalanceWei = 0n, holders = 0;
  const byType = {};
  for (const row of store.holders()) {
    const type = holderType(row), amount = BigInt(row.balanceWei);
    nativeBalanceWei += amount; holders++;
    const group = byType[type] ??= { addresses: 0, balanceWei: 0n };
    group.addresses++; group.balanceWei += amount;
  }
  return { stateAccounts: store.get('accountCount'), holders, nativeBalanceWei, byType,
    zeroBalanceAccounts: store.get('accountCount') - holders,
    zeroBalanceAccountsWithoutPreimage: store.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE balance_wei='0' AND address IS NULL").get().n };
}
