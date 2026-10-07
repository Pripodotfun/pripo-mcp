import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zeroHash } from 'viem';
import { Transactions } from '../src/transactions.js';
import { ToolError } from '../src/errors.js';
import { account, config, fixture, prepared } from './helpers.js';

const code = (expected: string) => (e: unknown) => e instanceof ToolError && e.code === expected;
test('concurrent retries persist first and sign one nonce; changed arguments conflict', async () => {
  const { tx, node, store } = fixture(); let preparations = 0;
  const prepare = async () => { preparations++; return prepared; };
  const [a, b] = await Promise.all([tx.submit('open-1', { size: '1' }, prepare), tx.submit('open-1', { size: '1' }, prepare)]);
  assert.equal(preparations, 1); assert.equal(store.saved.entries.length, 1);
  assert.equal(a.transactionHash, b.transactionHash); assert.equal(node.sends[0], node.sends[1]);
  assert.ok(!JSON.stringify(a).includes(store.saved.entries[0]!.raw));
  await assert.rejects(tx.submit('open-1', { size: '2' }, prepare), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(tx.submit('open-2', { size: '1' }, prepare), code('TRANSACTION_PENDING'));
});
test('lost submission response recovers identical signed bytes after restart', async () => {
  const { tx, rpc, node, store } = fixture(); node.timeout = true;
  const a = await tx.submit('lost-response', {}, async () => prepared);
  assert.equal(a.status, 'submission_unknown');
  store.state = structuredClone(store.saved);
  const restarted = new Transactions(rpc, config, store, account); await restarted.initialize();
  node.timeout = false;
  const b = await restarted.submit('lost-response', {}, async () => { throw new Error('must not prepare again'); });
  assert.equal(b.transactionHash, a.transactionHash); assert.deepEqual(node.sends, [node.sends[0], node.sends[0]]);
});
test('confirmation depth, canonical block and reorg downgrade are enforced', async () => {
  const { tx, node } = fixture(); await tx.submit('receipt', {}, async () => prepared);
  node.receipt = { blockNumber: 100n, blockHash: zeroHash, status: 'success' };
  node.head = 100n; assert.equal((await tx.status('receipt')).status, 'pending');
  node.head = 101n; assert.equal((await tx.status('receipt')).status, 'confirmed');
  node.blockHash = `0x${'22'.repeat(32)}`;
  const stale = await tx.status('receipt'); assert.equal(stale.status, 'submission_unknown'); assert.equal(stale.receiptBlock, undefined);
  node.blockHash = zeroHash; node.receipt.status = 'reverted';
  assert.equal((await tx.status('receipt')).status, 'reverted');
  node.receipt = undefined; assert.equal((await tx.status('receipt')).status, 'submission_unknown');
});
test('disk failure freezes submissions without broadcasting', async () => {
  const { tx, node, store } = fixture(); store.fail = true;
  await assert.rejects(tx.submit('disk', {}, async () => prepared)); assert.equal(node.sends.length, 0);
  store.fail = false;
  await assert.rejects(tx.submit('disk', {}, async () => prepared), code('JOURNAL_UNAVAILABLE'));
});
test('chain, signer, gas, value, fee, balance, pending nonce and cancellation fail closed', async () => {
  for (const kind of ['chain', 'signer', 'gas', 'value', 'fee', 'balance', 'nonce', 'cancel'] as const) {
    const { tx, node, store } = fixture(); const p = structuredClone(prepared); const abort = new AbortController();
    if (kind === 'chain') node.chainId = 1;
    if (kind === 'signer') p.request.account = config.owner!;
    if (kind === 'gas') p.request.gas = 3_000_001n;
    if (kind === 'value') p.request.value = 10n ** 18n;
    if (kind === 'fee') node.fee = 10n ** 15n;
    if (kind === 'balance') node.balance = 0n;
    if (kind === 'nonce') node.pending = 1;
    if (kind === 'cancel') abort.abort();
    await assert.rejects(tx.submit(kind, {}, async () => p, abort.signal), e => e instanceof ToolError);
    assert.equal(node.sends.length, 0, kind); assert.equal(store.saved.entries.length, 0, kind);
  }
});
test('receipt lag does not trigger replacement when the nonce is already mined', async () => {
  const { tx, node } = fixture(); await tx.submit('lag', {}, async () => prepared); node.mined = 1;
  await tx.submit('lag', {}, async () => { throw new Error('replacement'); }); assert.equal(node.sends.length, 1);
  await assert.rejects(tx.submit('next', {}, async () => prepared), code('TRANSACTION_PENDING'));
});
test('corrupt signed transaction journal cannot initialize', async () => {
  const { tx, store } = fixture(); await tx.submit('corrupt', {}, async () => prepared);
  store.state.entries[0]!.nonce = 99;
  await assert.rejects(tx.initialize(), code('JOURNAL_INVALID'));
});
test('RPC failure checking a receipt is not mistaken for an absent transaction', async () => {
  const { tx, rpc, node } = fixture(); await tx.submit('rpc', {}, async () => prepared);
  rpc.getTransactionReceipt = async () => { throw new Error('provider offline'); };
  await assert.rejects(tx.submit('rpc', {}, async () => prepared), /provider offline/);
  assert.equal(node.sends.length, 1);
});
