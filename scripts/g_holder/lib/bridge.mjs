import { Interface, getAddress } from 'ethers';
import { parse, hash, uint } from './data.mjs';
import { hex } from './rpc.mjs';
export const G_TOKEN = '0x9c7beba8f6ef6643abd725e45a4e8387ef260649';
export const BRIDGE = '0x7983403dda368aa7d67145a9b81c5c517f364c42';
const ABI = new Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function nativeToken() view returns (address)']);

export function bridgeReconciliation(nativeBalanceWei, escrowWei, alpha, ethereum, ledgerText = null) {
  const rawDifferenceWei = BigInt(escrowWei) - BigInt(nativeBalanceWei);
  if (ledgerText === null) return { status: rawDifferenceWei === 0n ? 'unadjusted_match' : 'unadjusted_difference', escrowWei, nativeBalanceWei, rawDifferenceWei, adjustmentsVerified: false, entries: null };
  const ledger = parse(ledgerText);
  if (ledger.format !== 'gravity-bridge-adjustments-v1' || String(ledger.alpha?.block) !== String(alpha.block) || hash(ledger.alpha?.blockHash) !== alpha.blockHash || String(ledger.ethereum?.block) !== String(ethereum.block) || hash(ledger.ethereum?.blockHash) !== ethereum.blockHash || !Array.isArray(ledger.entries)) throw new Error('Bridge adjustments snapshot identity mismatch');
  let total = 0n;
  const entries = ledger.entries.map(entry => {
    if (!['deposit_pending', 'withdrawal_pending', 'direct_surplus', 'protocol_adjustment'].includes(entry.kind) || typeof entry.evidence !== 'string' || !entry.evidence.trim()) throw new Error('Bridge adjustment requires a known kind and evidence reference');
    let amount;
    if (entry.kind === 'protocol_adjustment' && typeof entry.amountWei === 'string' && entry.amountWei.startsWith('-')) amount = -BigInt(uint(entry.amountWei.slice(1)));
    else amount = BigInt(uint(entry.amountWei));
    total += amount;
    return { kind: entry.kind, amountWei: amount.toString(), evidence: entry.evidence };
  });
  const residualWei = rawDifferenceWei - total;
  return { status: residualWei === 0n ? 'adjusted_match' : 'adjusted_difference', escrowWei, nativeBalanceWei, rawDifferenceWei, adjustmentsWei: total, residualWei, entries, adjustmentsVerified: false,
    evidenceScope: 'Arithmetic against supplied adjustment ledger; bridge messages and evidence references are not independently verified by this tool.' };
}

export async function readBridge(rpc, block, alpha, nativeBalanceWei, ledgerText) {
  const header = await rpc.pin(block);
  const requests = [['nativeToken', BRIDGE, []], ['decimals', G_TOKEN, []], ['balanceOf', G_TOKEN, [BRIDGE]]];
  const responses = await rpc.batch(requests.map(([method, to, args]) => ({ method: 'eth_call', params: [{ to, data: ABI.encodeFunctionData(method, args) }, hex(block)] })));
  const decoded = responses.map((value, i) => ABI.decodeFunctionResult(requests[i][0], value)[0]);
  if (getAddress(decoded[0]).toLowerCase() !== G_TOKEN || decoded[1] !== 18n) throw new Error('Ethereum bridge native token or decimals mismatch');
  await rpc.assertCanonical();
  const ethereum = { chainId: 1, block, blockHash: header.hash, timestamp: uint(header.timestamp), token: G_TOKEN, bridge: BRIDGE };
  return { ...bridgeReconciliation(nativeBalanceWei, decoded[2].toString(), alpha, ethereum, ledgerText), ethereum, rawResponses: responses };
}
