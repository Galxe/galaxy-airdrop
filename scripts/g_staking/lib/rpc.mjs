// RPC retry/batch pattern adapted from PR #6 (efece3a), with endpoint identity checks.
export const hex = value => `0x${BigInt(value).toString(16)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class RpcError extends Error {
  constructor(error) { super(error.message); this.code = error.code; }
}
export const isRangeError = error => /logs count|too many (results|logs)|block range|response size|query returned more|limit.*10000/i.test(error.message);
const isTransient = error => /rate|too many requests|timeout|timed out|temporar|busy|limit exceeded/i.test(error.message);

export class Rpc {
  constructor(urls, { batchSize = 10, delay = 200, timeout = 20000, retries = 2, fetcher = fetch } = {}) {
    this.urls = [...new Set(urls.filter(Boolean))];
    if (!this.urls.length) throw new Error('RPC endpoint required');
    for (const url of this.urls) if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Invalid RPC URL');
    Object.assign(this, { batchSize, delay, timeout, retries, fetcher });
    this.sequence = 0;
    this.active = 0;
  }
  payload(method, params) { return { jsonrpc: '2.0', id: ++this.sequence, method, params }; }
  async post(index, payload) {
    if (this.delay) await sleep(this.delay);
    let response;
    try {
      response = await this.fetcher(this.urls[index], {
        method: 'POST', signal: AbortSignal.timeout(this.timeout),
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'gravity-staking-snapshot/1.0' },
        body: JSON.stringify(payload),
      });
    } catch { throw new Error('RPC transport failed or timed out'); }
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error('Invalid RPC JSON response'); }
  }
  decode(response, request) {
    if (!response || response.id !== request.id) throw new Error('RPC response ID mismatch');
    if (response.error) throw new RpcError(response.error);
    if (!Object.hasOwn(response, 'result')) throw new Error('RPC result missing');
    return response.result;
  }
  async validateEndpoint(index) {
    const chain = this.payload('eth_chainId', []);
    const block = this.payload('eth_getBlockByNumber', [hex(this.identity.block), false]);
    const chainId = this.decode(await this.post(index, chain), chain);
    const header = this.decode(await this.post(index, block), block);
    if (BigInt(chainId) !== 1625n || header?.hash !== this.identity.blockHash) {
      throw new Error('RPC failover snapshot identity mismatch');
    }
  }
  async request(payload) {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      for (let offset = 0; offset < this.urls.length; offset++) {
        const index = (this.active + offset) % this.urls.length;
        if (this.identity && index !== this.active) {
          // Never send snapshot reads to a failover until it proves the same chain/block.
          try { await this.validateEndpoint(index); }
          catch (error) {
            if (/identity mismatch/.test(error.message)) throw error;
            continue;
          }
        }
        try {
          const result = await this.post(index, payload);
          this.active = index;
          return result;
        } catch { /* Bounded retry; URLs and credentials are deliberately not logged. */ }
      }
      if (attempt < this.retries) await sleep(250 * 2 ** attempt);
    }
    throw new Error('RPC transport unavailable on all configured endpoints');
  }
  async call(method, params) {
    const request = this.payload(method, params);
    for (let attempt = 0; ; attempt++) {
      try { return this.decode(await this.request(request), request); }
      catch (error) {
        if (!(error instanceof RpcError) || attempt >= this.retries || isRangeError(error) || !isTransient(error)) throw error;
        await sleep(250 * 2 ** attempt);
      }
    }
  }
  async batch(calls) {
    const result = [];
    for (let start = 0; start < calls.length; start += this.batchSize) {
      const part = calls.slice(start, start + this.batchSize);
      if (part.length === 1) { result.push(await this.call(part[0].method, part[0].params)); continue; }
      const requests = part.map(({ method, params }) => this.payload(method, params));
      const responses = await this.request(requests);
      if (!Array.isArray(responses) || responses.length !== requests.length) throw new Error('Incomplete RPC batch; use --batch-size 1 if unsupported');
      const byId = new Map(responses.map(response => [response.id, response]));
      if (byId.size !== requests.length || responses.some(response => !requests.some(request => request.id === response.id))) throw new Error('Duplicate or unknown RPC batch ID');
      for (const request of requests) {
        try { result.push(this.decode(byId.get(request.id), request)); }
        catch (error) {
          if (!(error instanceof RpcError) || !isTransient(error)) throw error;
          result.push(await this.call(request.method, request.params));
        }
      }
    }
    return result;
  }
  async pin(block) {
    if (BigInt(await this.call('eth_chainId', [])) !== 1625n) throw new Error('Expected Gravity Alpha chain ID 1625');
    const header = await this.call('eth_getBlockByNumber', [hex(block), false]);
    if (!header || BigInt(header.number) !== BigInt(block) || !/^0x[0-9a-f]{64}$/i.test(header.hash)) throw new Error('Target block unavailable');
    this.identity = { block, blockHash: header.hash };
    return header;
  }
  async assertCanonical() {
    const header = await this.call('eth_getBlockByNumber', [hex(this.identity.block), false]);
    if (header?.hash !== this.identity.blockHash) throw new Error('Target block hash changed; discard this run');
  }
}

export async function contractCall(rpc, address, abi, method, args, block, optional = false) {
  let data;
  try { data = await rpc.call('eth_call', [{ to: address, data: abi.encodeFunctionData(method, args) }, hex(block)]); }
  catch (error) {
    if (optional && error instanceof RpcError && (error.code === 3 || /execution reverted|VM execution error.*revert/i.test(error.message))) return null;
    throw error;
  }
  try { return abi.decodeFunctionResult(method, data)[0]; }
  catch (error) {
    if (optional && ['BAD_DATA', 'BUFFER_OVERRUN', 'INVALID_ARGUMENT'].includes(error.code)) return null;
    throw error;
  }
}
