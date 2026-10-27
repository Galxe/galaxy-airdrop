// Adapted from Galxe/galaxy-airdrop PR #6, commit efece3a83b48dc9d610ddc12b1ca063eb4ae13aa.
import { Interface, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { getProxyFactoryDeployment, getSafeSingletonDeployment, getSafeL2SingletonDeployment } from '@safe-global/safe-deployments';
import { contractCall, hex } from './rpc.mjs';
const lower = address => getAddress(address).toLowerCase();
export const SAFE = new Interface([
  'function masterCopy() view returns (address)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function proxyRuntimeCode() view returns (bytes)',
]);
export async function loadSafeRegistry(rpc, block) {
  const implementationHashes = new Map(), factories = new Map();
  // keccak256(deployedBytecode) from the official @safe-global/safe-contracts
  // 1.4.1 artifact: build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json.
  // Its factory exposes proxyCreationCode(), but not proxyRuntimeCode().
  // Artifact: https://unpkg.com/@safe-global/safe-contracts@1.4.1/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json
  const proxyHashes = new Set(['0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c']);
  for (const version of ['1.0.0', '1.1.1', '1.2.0', '1.3.0', '1.4.1', '1.5.0']) {
    for (const accessor of [getSafeSingletonDeployment, getSafeL2SingletonDeployment]) {
      const deployment = accessor({ version });
      for (const [type, entry] of Object.entries(deployment?.deployments ?? {})) {
        if (type !== 'zksync') implementationHashes.set(entry.codeHash.toLowerCase(), version);
      }
    }
    const factory = getProxyFactoryDeployment({ version });
    for (const [type, entry] of Object.entries(factory?.deployments ?? {})) {
      if (type !== 'zksync') factories.set(entry.address, entry.codeHash.toLowerCase());
    }
  }
  for (const [address, expectedHash] of factories) {
    const code = await rpc.call('eth_getCode', [address, hex(block)]);
    if (code === '0x' || keccak256(code) !== expectedHash) continue;
    const runtime = await contractCall(rpc, address, SAFE, 'proxyRuntimeCode', [], block, true);
    if (runtime && runtime !== '0x') proxyHashes.add(keccak256(runtime));
  }
  return { implementationHashes, proxyHashes };
}

export async function classify(rpc, address, code, block, registry) {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(code)) throw new Error('Invalid eth_getCode result');
  const numeric = BigInt(address);
  if ((numeric >= 1n && numeric <= 10n) || (numeric >= 100n && numeric <= 114n) || numeric === 255n) {
    return { type: 'SPECIAL', evidence: 'evm_or_nitro_reserved_address' };
  }
  if (code === '0x') return { type: 'EOA', evidence: 'empty_code_at_block' };
  if (/^0xef0100[0-9a-f]{40}$/i.test(code)) {
    return { type: 'EOA_DELEGATED', evidence: 'eip7702_delegation', delegation: `0x${code.slice(8)}` };
  }
  const other = { type: 'CONTRACT', evidence: 'code_present_safe_not_verified' };
  // Unknown contracts may fail with invalid opcode/out of gas for Safe selectors.
  // Only recognized proxy bytecode is eligible for Safe verification.
  if (!registry.proxyHashes.has(keccak256(code))) return other;
  const masterCopy = await contractCall(rpc, address, SAFE, 'masterCopy', [], block, true);
  if (!masterCopy || masterCopy === ZeroAddress) return other;
  const owners = await contractCall(rpc, address, SAFE, 'getOwners', [], block, true);
  const threshold = await contractCall(rpc, address, SAFE, 'getThreshold', [], block, true);
  if (!owners?.length || threshold == null || threshold < 1n || threshold > BigInt(owners.length)) return other;
  const version = await contractCall(rpc, address, SAFE, 'VERSION', [], block, true);
  const implementationCode = await rpc.call('eth_getCode', [masterCopy, hex(block)]);
  const knownVersion = registry.implementationHashes.get(keccak256(implementationCode));
  const slot0 = await rpc.call('eth_getStorageAt', [address, '0x0', hex(block)]);
  const validOwners = owners.every(owner => owner !== ZeroAddress && BigInt(owner) !== 1n) && new Set(owners.map(lower)).size === owners.length;
  const verified = knownVersion && version === knownVersion &&
    /^0x[0-9a-f]{64}$/i.test(slot0) && lower(`0x${slot0.slice(-40)}`) === lower(masterCopy) && validOwners;
  return {
    type: verified ? 'SAFE' : 'CONTRACT',
    evidence: verified ? 'official_proxy_and_implementation_code_hashes' : 'safe_like_unverified',
    safe: { verified: Boolean(verified), implementation: lower(masterCopy), version, owners: owners.map(lower), threshold: Number(threshold), requiresMultipleSigners: threshold > 1n },
  };
}
