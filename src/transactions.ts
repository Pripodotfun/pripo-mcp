import { isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress, stringToHex, TransactionReceiptNotFoundError,
  type LocalAccount, type PublicClient, type TransactionSerialized } from 'viem';
import type { PreparedTransaction } from '@pripo/sdk';
import type { Config } from './config.js';
import type { Entry, Store } from './store.js';
import { ToolError } from './errors.js';

export const fingerprint = (intent: unknown) => keccak256(stringToHex(JSON.stringify(intent)));
const active = (entry: Entry) => entry.status === 'pending' || entry.status === 'submission_unknown';
export const publicTransaction = (entry: Entry) => ({ requestId: entry.requestId, transactionHash: entry.hash,
  nonce: entry.nonce, status: entry.status, createdBlock: entry.createdBlock, receiptBlock: entry.receiptBlock,
  receiptBlockHash: entry.receiptBlockHash, retry: 'Reuse the same request_id and arguments; do not create a new ID to retry this transaction.' });

/** One pending nonce per dedicated signer; the journal owns retries across MCP sessions. */
export class Transactions {
  private tail: Promise<unknown> = Promise.resolve();
  private frozen = false;
  constructor(private readonly rpc: PublicClient, private readonly config: Config, private readonly store: Store, private readonly account: LocalAccount) {}
  async initialize() {
    for (const entry of this.store.state.entries) {
      const tx = parseTransaction(entry.raw as TransactionSerialized);
      if (keccak256(entry.raw as TransactionSerialized) !== entry.hash || tx.nonce !== entry.nonce || tx.chainId !== this.config.chainId
        || !isAddressEqual(await recoverTransactionAddress({ serializedTransaction: entry.raw as TransactionSerialized }), this.account.address)) {
        throw new ToolError('JOURNAL_INVALID', 'Journal contains a transaction with an invalid signature, chain, nonce or hash.');
      }
    }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action); this.tail = next.catch(() => {}); return next;
  }
  async idle() { await this.tail; }
  private async save() {
    try { await this.store.save(); }
    catch (error) { this.frozen = true; throw error; }
  }
  private async refresh(entry: Entry) {
    let receipt;
    try { receipt = await this.rpc.getTransactionReceipt({ hash: entry.hash as `0x${string}` }); }
    catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error; }
    if (!receipt) {
      if (!active(entry)) { entry.status = 'submission_unknown'; delete entry.receiptBlock; delete entry.receiptBlockHash; await this.save(); }
      return;
    }
    const [block, head] = await Promise.all([this.rpc.getBlock({ blockNumber: receipt.blockNumber }), this.rpc.getBlockNumber({ cacheTime: 0 })]);
    if (block.hash !== receipt.blockHash || head < receipt.blockNumber + BigInt(this.config.confirmations - 1)) {
      if (!active(entry)) { entry.status = 'submission_unknown'; delete entry.receiptBlock; delete entry.receiptBlockHash; await this.save(); }
      return;
    }
    entry.status = receipt.status === 'success' ? 'confirmed' : 'reverted';
    entry.receiptBlock = receipt.blockNumber.toString(); entry.receiptBlockHash = receipt.blockHash;
    await this.save();
  }
  status(requestId: string) {
    return this.serial(async () => {
      if (await this.rpc.getChainId() !== this.config.chainId) throw new ToolError('CHAIN_MISMATCH', 'RPC chain differs from configured deployment.');
      const entry = this.store.state.entries.find(e => e.requestId === requestId);
      if (!entry) throw new ToolError('REQUEST_NOT_FOUND', 'No transaction exists for this request_id.');
      await this.refresh(entry); return publicTransaction(entry);
    });
  }
  submit(requestId: string, intent: unknown, prepare: () => Promise<PreparedTransaction>, signal?: AbortSignal) {
    return this.serial(async () => {
      if (this.frozen) throw new ToolError('JOURNAL_UNAVAILABLE', 'Transaction storage failed; restart after checking the journal.');
      if (signal?.aborted) throw new ToolError('CANCELLED', 'Request cancelled before transaction processing.');
      if (await this.rpc.getChainId() !== this.config.chainId) throw new ToolError('CHAIN_MISMATCH', 'RPC chain differs from configured deployment.');
      const digest = fingerprint(intent);
      const existing = this.store.state.entries.find(e => e.requestId === requestId);
      if (existing) {
        if (existing.fingerprint !== digest) throw new ToolError('IDEMPOTENCY_CONFLICT', 'This request_id already belongs to different arguments.');
        await this.refresh(existing);
        if (active(existing) && !signal?.aborted) await this.broadcast(existing);
        return publicTransaction(existing);
      }
      for (const entry of this.store.state.entries.filter(active)) await this.refresh(entry);
      const pending = this.store.state.entries.find(active);
      if (pending) throw new ToolError('TRANSACTION_PENDING', 'Wait for the existing transaction before submitting another intent.', publicTransaction(pending));
      if (this.store.state.entries.length >= 10_000) throw new ToolError('JOURNAL_FULL', 'Journal reached its capacity; migrate completed history before accepting new requests.');
      if (signal?.aborted) throw new ToolError('CANCELLED', 'Request cancelled before transaction preparation.');
      const prepared = await prepare();
      const p = prepared.request;
      if (p.chainId !== this.config.chainId || !isAddressEqual(p.account, this.account.address)) throw new ToolError('SIGNER_MISMATCH', 'Prepared transaction does not match the configured signer and chain.');
      if (p.gas > BigInt(this.config.maxGas) || p.value > BigInt(this.config.maxNativeValue)) throw new ToolError('TRANSACTION_LIMIT', 'Prepared gas or native value exceeds the server limit.');
      const [mined, remotePending, balance, fees] = await Promise.all([
        this.rpc.getTransactionCount({ address: this.account.address, blockTag: 'latest' }),
        this.rpc.getTransactionCount({ address: this.account.address, blockTag: 'pending' }),
        this.rpc.getBalance({ address: this.account.address }), this.rpc.estimateFeesPerGas(),
      ]);
      const previousNonce = this.store.state.entries.reduce((max, e) => Math.max(max, e.nonce), -1);
      if (mined !== remotePending || mined <= previousNonce) throw new ToolError('NONCE_UNCERTAIN', 'Signer has an untracked pending transaction or a nonce regression. Reconcile before continuing.');
      if (fees.maxFeePerGas > BigInt(this.config.maxFeePerGas) || balance < p.gas * fees.maxFeePerGas + p.value) throw new ToolError('TRANSACTION_LIMIT', 'Gas price cap or operator native balance prevents submission.');
      if (signal?.aborted) throw new ToolError('CANCELLED', 'Request cancelled before signing.');
      const raw = await this.account.signTransaction({ type: 'eip1559', chainId: p.chainId, nonce: mined,
        to: p.to, data: p.data, value: p.value, gas: p.gas, ...fees });
      const entry: Entry = { requestId, fingerprint: digest, hash: keccak256(raw), raw, nonce: mined,
        createdBlock: prepared.blockNumber.toString(), status: 'pending' };
      this.store.state.entries.push(entry);
      await this.save(); // Durable bytes and ID must exist before any broadcast attempt.
      await this.broadcast(entry);
      return publicTransaction(entry);
    });
  }
  private async broadcast(entry: Entry) {
    // Never sign a replacement when the original submission response was lost.
    const mined = await this.rpc.getTransactionCount({ address: this.account.address, blockTag: 'latest' });
    if (mined > entry.nonce) return; // Receipt may lag asynchronous execution.
    try {
      const hash = await this.rpc.sendRawTransaction({ serializedTransaction: entry.raw as TransactionSerialized });
      entry.status = hash === entry.hash ? 'pending' : 'submission_unknown';
    } catch { entry.status = 'submission_unknown'; }
    await this.save();
  }
}
