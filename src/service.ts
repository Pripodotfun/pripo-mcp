import { createPripoClient, type PripoClient, type CreateMarketParams } from '@pripo/sdk';
import { marketAbi, marketFactoryAbi, marginVaultAbi } from '@pripo/sdk/abis';
import { createPublicClient, http, isAddressEqual, type Address, type Chain, type Hex } from 'viem';
import type { Config } from './config.js';
import { ToolError, json } from './errors.js';
import type { Transactions } from './transactions.js';

export type OpenInput = { market: Address; size: string; limit_price: string; market_proof: string[] };
export type CloseInput = { market: Address; size_fraction: string; limit_price: string; market_proof: string[] };
export type CreationInput = { symbol: string; price_source: Address; feed_id: string; initial_price: string; depth: string; seed_bond_usdc: string };

export class PripoService {
  constructor(readonly config: Config, readonly sdk: PripoClient, readonly transactions?: Transactions) {}
  static connect(config: Config, chain: Chain) {
    const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl, { batch: { batchSize: 20 }, timeout: 20_000, retryCount: 2 }), cacheTime: 0 });
    return new PripoService(config, createPripoClient({ publicClient, chain, factory: config.factory, vault: config.vault,
      account: config.operator, pythAdapters: config.pythAdapters }));
  }
  async verifyDeployment() {
    await this.sdk.assertChain();
    const blockNumber = await this.sdk.block();
    const [vault, registered] = await Promise.all([
      this.sdk.publicClient.readContract({ address: this.config.factory, abi: marketFactoryAbi, functionName: 'vault', blockNumber }),
      this.sdk.publicClient.readContract({ address: this.config.vault, abi: marginVaultAbi, functionName: 'registrars', args: [this.config.factory], blockNumber }),
    ]);
    if (!isAddressEqual(vault, this.config.vault) || !registered) throw new ToolError('DEPLOYMENT_MISMATCH', 'Configured factory and vault are not wired together.');
  }
  info() {
    return { chainId: this.config.chainId, factory: this.config.factory, vault: this.config.vault, owner: this.config.owner,
      operator: this.config.operator, mode: this.config.broadcast ? 'broadcast' : 'read-only',
      indexerConfigured: Boolean(this.config.indexerUrl), settlementSupported: false,
      creationEnabled: BigInt(this.config.maxCreationSeedBondUsdc) > 0n,
      units: { pricesSizesMarginPnlFunding: 'WAD: integer strings, 18 decimals', seedBondUsdc: 'integer strings, 6 decimals', policyExpiry: 'block number' },
      writes: 'Delegated owner is fixed in server configuration. Exact policy limits are checked by contract simulation. Request IDs persist across restarts.' };
  }
  user(user?: Address) {
    const resolved = user ?? this.config.owner;
    if (!resolved) throw new ToolError('USER_REQUIRED', 'Provide a user address or configure PRIPO_MCP_OWNER.');
    return resolved;
  }
  private async atBlock<T>(read: (blockNumber: bigint) => Promise<T>) {
    await this.sdk.assertChain();
    const before = await this.sdk.publicClient.getBlock({ blockTag: 'latest' });
    const data = await read(before.number);
    const after = await this.sdk.publicClient.getBlock({ blockNumber: before.number });
    if (before.hash !== after.hash) throw new ToolError('CHAIN_REORG', 'The read block changed; retry for a consistent snapshot.');
    return { chainId: this.config.chainId, source: 'rpc', asOf: { blockNumber: before.number, blockHash: before.hash, timestamp: before.timestamp }, ...data };
  }
  listMarkets(offset: string, limit: number) {
    return this.atBlock(async blockNumber => {
      const page = await this.sdk.listMarkets({ offset: BigInt(offset), limit, blockNumber });
      const nextOffset = BigInt(offset) + BigInt(page.markets.length);
      return { ...page, nextOffset: nextOffset < page.total ? nextOffset : null };
    });
  }
  market(address: Address) {
    return this.atBlock(async blockNumber => {
      await this.sdk.validateMarket(address, blockNumber);
      const market = this.sdk.market(address), rpc = this.sdk.publicClient;
      const [config, markPrice, interest, indexPrice, fundingState, ledger] = await Promise.all([
        market.config({ blockNumber }),
        rpc.readContract({ address, abi: marketAbi, functionName: 'markPrice', blockNumber }),
        rpc.readContract({ address, abi: marketAbi, functionName: 'openInterest', blockNumber }),
        rpc.readContract({ address, abi: marketAbi, functionName: 'indexPrice', blockNumber }),
        rpc.readContract({ address, abi: marketAbi, functionName: 'fundingState', blockNumber }),
        rpc.readContract({ address: this.config.vault, abi: marginVaultAbi, functionName: 'ledger', args: [address], blockNumber }),
      ]);
      return { market: address, config, markPrice, openInterest: { long: interest[0], short: interest[1], cap: interest[2] },
        index: { price: indexPrice[0], updatedBlock: indexPrice[1], external: indexPrice[2] }, fundingState, ledger };
    });
  }
  async book(address: Address, source: 'rpc' | 'indexer', maxAgeSeconds: number) {
    if (source === 'rpc') return this.atBlock(async blockNumber => {
      await this.sdk.validateMarket(address, blockNumber);
      return { market: address, ...await this.sdk.market(address).book({ blockNumber }) };
    });
    if (!this.config.indexerUrl) throw new ToolError('INDEXER_UNAVAILABLE', 'PRIPO_MCP_INDEXER_URL is not configured.');
    await this.sdk.assertChain();
    const blockNumber = await this.sdk.block(); await this.sdk.validateMarket(address, blockNumber);
    const url = new URL(`/markets/${address.toLowerCase()}/book`, this.config.indexerUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new ToolError('INDEXER_UNAVAILABLE', 'Indexed book is unavailable; use source=rpc for a fresh contract read.');
    const data = await response.json() as { chainId: number; market: string; asOf: { blockNumber: number; blockHash: string; timestamp: number }; book: unknown };
    if (data.chainId !== this.config.chainId || typeof data.market !== 'string' || data.market.toLowerCase() !== address.toLowerCase()
      || !Number.isSafeInteger(data.asOf?.blockNumber) || !Number.isSafeInteger(data.asOf?.timestamp) || typeof data.asOf?.blockHash !== 'string') {
      throw new ToolError('INDEXER_MISMATCH', 'Indexer returned a different market, chain or invalid snapshot provenance.');
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - data.asOf.timestamp;
    if (ageSeconds < -30 || ageSeconds > maxAgeSeconds) throw new ToolError('STALE_INDEXER', 'Indexed snapshot exceeds the requested age; use source=rpc.', { ageSeconds, maxAgeSeconds, asOf: data.asOf });
    const canonical = await this.sdk.publicClient.getBlock({ blockNumber: BigInt(data.asOf.blockNumber) });
    if (canonical.hash !== data.asOf.blockHash || Number(canonical.timestamp) !== data.asOf.timestamp) throw new ToolError('CHAIN_REORG', 'Indexed book does not belong to the canonical block.');
    return { ...data, source: 'indexer', asOf: { ...data.asOf, ageSeconds }, executionQuote: false };
  }
  positions(user: Address | undefined, marketAddress: Address | undefined, offset: string, limit: number) {
    const owner = this.user(user);
    return this.atBlock(async blockNumber => {
      const page = marketAddress ? { markets: [marketAddress], total: 1n } : await this.sdk.listMarkets({ offset: BigInt(offset), limit, blockNumber });
      const positions = [];
      for (const address of page.markets) {
        await this.sdk.validateMarket(address, blockNumber);
        const position = await this.sdk.market(address).position(owner, { blockNumber });
        if (position.size !== 0n || position.adlPending) positions.push({ market: address, user: owner, ...position });
      }
      const next = BigInt(offset) + BigInt(page.markets.length);
      return { user: owner, freeBalanceWad: await this.sdk.vault.freeBalance(owner, { blockNumber }), positions,
        marketsScanned: page.markets.length, nextOffset: !marketAddress && next < page.total ? next : null };
    });
  }
  health(address: Address, user?: Address) {
    const owner = this.user(user);
    return this.atBlock(async blockNumber => {
      await this.sdk.validateMarket(address, blockNumber);
      const market = this.sdk.market(address);
      const [health, liquidation, position, pendingAdl] = await Promise.all([market.health(owner, { blockNumber }),
        market.liquidationPrice(owner, { blockNumber }), market.position(owner, { blockNumber }), market.pendingAdl(owner, { blockNumber })]);
      return { market: address, user: owner, ...health, liquidation, position, pendingAdl,
        healthDefinition: 'equity / entry notional, WAD; a zero liquidation price requires interpreting referenceKind and reason' };
    });
  }
  quoteOpen(address: Address, user: Address | undefined, size: string) {
    const owner = this.user(user);
    return this.atBlock(async blockNumber => {
      await this.sdk.validateMarket(address, blockNumber);
      return { market: address, user: owner, size, ...await this.sdk.market(address).quoteOpen(owner, BigInt(size), { blockNumber }), executableGuarantee: false };
    });
  }
  quoteClose(address: Address, user: Address | undefined, fraction: string) {
    const owner = this.user(user);
    return this.atBlock(async blockNumber => {
      await this.sdk.validateMarket(address, blockNumber);
      return { market: address, user: owner, sizeFraction: fraction, ...await this.sdk.market(address).quoteClose(owner, BigInt(fraction), { blockNumber }), executableGuarantee: false };
    });
  }
  operatorPolicy() {
    const owner = this.user();
    if (!this.config.operator) throw new ToolError('OPERATOR_REQUIRED', 'Configure an operator address for policy reads and previews.');
    return this.atBlock(async blockNumber => {
      const policy = await this.sdk.vault.operator(owner, this.config.operator!, { blockNumber });
      return { user: owner, operator: this.config.operator, policy, expired: policy.expiry <= blockNumber };
    });
  }
  private async checkOperator(close: boolean) {
    const { policy, expired } = await this.operatorPolicy();
    if (this.config.operator === this.config.owner) throw new ToolError('OPERATOR_REQUIRED', 'Trading requires a delegated operator distinct from the owner.');
    if (expired || policy.maxNotionalPerTx === 0n || policy.maxTotalNotional === 0n) throw new ToolError('POLICY_VIOLATION', 'Operator policy is absent or expired.', { policyCode: 1 });
    if (close && !policy.canClose) throw new ToolError('POLICY_VIOLATION', 'Operator policy does not permit closing.', { policyCode: 2 });
    // Do not reconstruct exact notional from a rounded avgFill. The SDK simulates
    // the contract's exact proof, per-transaction and cumulative policy checks.
  }
  async prepareOpen(input: OpenInput) {
    await this.checkOperator(false);
    return this.sdk.market(input.market).prepareOpen({ user: this.user(), size: BigInt(input.size), limitPrice: BigInt(input.limit_price), marketProof: input.market_proof as Hex[] });
  }
  async prepareClose(input: CloseInput) {
    await this.checkOperator(true);
    return this.sdk.market(input.market).prepareClose({ user: this.user(), sizeFraction: BigInt(input.size_fraction), limitPrice: BigInt(input.limit_price), marketProof: input.market_proof as Hex[] });
  }
  async prepareCreation(input: CreationInput) {
    if (!this.config.operator || BigInt(this.config.maxCreationSeedBondUsdc) === 0n) throw new ToolError('CREATION_DISABLED', 'Market creation requires an explicit nonzero seed-bond cap in server configuration.');
    if (BigInt(input.seed_bond_usdc) > BigInt(this.config.maxCreationSeedBondUsdc)) throw new ToolError('CREATION_LIMIT', 'Seed bond exceeds the configured creation cap.');
    const params: CreateMarketParams = { symbol: input.symbol, priceSource: input.price_source, feedId: input.feed_id as Hex,
      initialPrice: BigInt(input.initial_price), depth: BigInt(input.depth), seedBond: BigInt(input.seed_bond_usdc) };
    return { ...await this.sdk.prepareCreateMarket(params), creator: this.config.operator, seedBondUsdc: input.seed_bond_usdc,
      fundingSource: 'operator wallet; creation does not use the trading owner\'s operator policy' };
  }
  write(kind: 'open' | 'close' | 'create', requestId: string, input: OpenInput | CloseInput | CreationInput, signal?: AbortSignal) {
    if (!this.config.broadcast || !this.transactions) throw new ToolError('READ_ONLY', 'Server is read-only. Configure a dedicated operator and start with --broadcast to enable submission.');
    const normalized = json(input);
    for (const key of ['market', 'price_source', 'feed_id']) if (typeof normalized[key] === 'string') normalized[key] = normalized[key].toLowerCase();
    if (Array.isArray(normalized.market_proof)) normalized.market_proof = normalized.market_proof.map(p => String(p).toLowerCase());
    return this.transactions.submit(requestId, { kind, owner: this.config.owner?.toLowerCase(), input: normalized },
      () => kind === 'open' ? this.prepareOpen(input as OpenInput) : kind === 'close' ? this.prepareClose(input as CloseInput) : this.prepareCreation(input as CreationInput), signal);
  }
}
