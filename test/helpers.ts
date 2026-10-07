import { privateKeyToAccount } from 'viem/accounts';
import { zeroAddress, zeroHash, TransactionReceiptNotFoundError, keccak256, type PublicClient, type Hex } from 'viem';
import type { PreparedTransaction } from '@pripo/sdk';
import type { Config } from '../src/config.js';
import type { Journal, Store } from '../src/store.js';
import { Transactions } from '../src/transactions.js';

// Public, deterministic test key; used only by mocks or an isolated local chain.
export const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
export const config: Config = { chainId: 31337, chainName: 'Test', nativeSymbol: 'ETH', factory: zeroAddress,
  vault: zeroAddress, pythAdapters: [], confirmations: 2, maxGas: '3000000', maxFeePerGas: '100000000000',
  maxNativeValue: '10000000000000000', maxCreationSeedBondUsdc: '0', rpcUrl: 'http://localhost:8545',
  owner: '0x0000000000000000000000000000000000000001', operator: account.address, broadcast: true, statePath: '.state/test.json' };
export const prepared: PreparedTransaction = { blockNumber: 100n, functionName: 'openFor', request: {
  chainId: config.chainId, account: account.address, to: config.factory, data: '0x1234', gas: 100_000n, value: 0n } };
export class MemoryStore implements Store {
  state: Journal = { version: 1, identity: 'test', entries: [] };
  saved: Journal = structuredClone(this.state);
  fail = false;
  async save() { if (this.fail) throw new Error('disk unavailable'); this.saved = structuredClone(this.state); }
  async close() {}
}
export function fixture(store = new MemoryStore()) {
  const node = { chainId: 31337, mined: 0, pending: 0, balance: 10n ** 20n, fee: 1_000_000_000n,
    head: 101n, blockHash: zeroHash as Hex, receipt: undefined as undefined | { blockNumber: bigint; blockHash: Hex; status: 'success' | 'reverted' },
    timeout: false, sends: [] as Hex[] };
  const rpc = {
    getChainId: async () => node.chainId,
    getTransactionCount: async ({ blockTag }: { blockTag: string }) => blockTag === 'pending' ? node.pending : node.mined,
    getBalance: async () => node.balance,
    estimateFeesPerGas: async () => ({ maxFeePerGas: node.fee, maxPriorityFeePerGas: 1n }),
    getBlockNumber: async () => node.head,
    getBlock: async () => ({ hash: node.blockHash }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!node.receipt) throw new TransactionReceiptNotFoundError({ hash }); return node.receipt;
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      if (store.saved.entries[0]?.raw !== serializedTransaction) throw new Error('Broadcast before persistence');
      node.sends.push(serializedTransaction);
      if (node.timeout) throw new Error('provider timeout containing SECRET');
      return keccak256(serializedTransaction);
    },
  } as unknown as PublicClient;
  return { node, rpc, store, tx: new Transactions(rpc, config, store, account) };
}
