import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PripoClient } from '@pripo/sdk';
import { zeroHash } from 'viem';
import { PripoService } from '../src/service.js';
import { ToolError } from '../src/errors.js';
import { config } from './helpers.js';

test('indexed book checks age, chain, market and canonical block; RPC remains the default fresh source', async t => {
  const timestamp = Math.floor(Date.now() / 1000);
  let blockHash: `0x${string}` = zeroHash;
  const sdk = { assertChain: async () => {}, block: async () => 100n, validateMarket: async () => {},
    publicClient: { getBlock: async () => ({ hash: blockHash, timestamp: BigInt(timestamp) }) } } as unknown as PripoClient;
  const service = new PripoService({ ...config, indexerUrl: 'http://indexer.invalid' }, sdk);
  const good = { chainId: config.chainId, market: config.factory, asOf: { blockNumber: 100, blockHash: zeroHash, timestamp },
    book: { positions: [{ entryCost: '100050025012506253127' }] } };
  let data: unknown = good;
  t.mock.method(globalThis, 'fetch', async () => Response.json(data));
  const result = await service.book(config.factory, 'indexer', 60);
  assert.equal(result.source, 'indexer'); assert.equal((result as { executionQuote: boolean }).executionQuote, false);
  data = { ...good, asOf: { ...good.asOf, timestamp: timestamp - 61 } };
  await assert.rejects(service.book(config.factory, 'indexer', 60), (e: unknown) => e instanceof ToolError && e.code === 'STALE_INDEXER');
  for (const bad of [{ ...good, chainId: 1 }, { ...good, market: config.owner }, { ...good, asOf: {} }]) {
    data = bad; await assert.rejects(service.book(config.factory, 'indexer', 60), /different market, chain/);
  }
  data = good; blockHash = `0x${'11'.repeat(32)}`;
  await assert.rejects(service.book(config.factory, 'indexer', 60), /canonical block/);
});
test('read snapshots fail if their block changes during the read', async () => {
  let calls = 0;
  const sdk = { assertChain: async () => {}, listMarkets: async ({ blockNumber }: { blockNumber: bigint }) => {
    assert.equal(blockNumber, 100n); return { total: 1n, markets: [config.factory] };
  }, publicClient: { getBlock: async () => ({ number: 100n, timestamp: 1n, hash: ++calls === 1 ? zeroHash : `0x${'11'.repeat(32)}` }) } } as unknown as PripoClient;
  await assert.rejects(new PripoService(config, sdk).listMarkets('0', 20), (e: unknown) => e instanceof ToolError && e.code === 'CHAIN_REORG');
});
test('creation disabled by default and cap is checked before preparing calldata', async () => {
  const input = { symbol: 'TEST', price_source: config.factory, feed_id: zeroHash, initial_price: '1', depth: '1', seed_bond_usdc: '2' };
  await assert.rejects(new PripoService(config, {} as PripoClient).prepareCreation(input), /explicit nonzero/);
  await assert.rejects(new PripoService({ ...config, maxCreationSeedBondUsdc: '1' }, {} as PripoClient).prepareCreation(input), /exceeds/);
});
