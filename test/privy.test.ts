import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexToBigInt, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.js';
import { createPrivyServerWallet, privyAccount } from '../src/privy.js';

const key = privateKeyToAccount(`0x${'11'.repeat(32)}`), other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const tx = { type: 'eip1559' as const, chainId: 999143, nonce: 7, to: '0x73e4Ea4161a844B8b857D9ffa8f8498324905121' as `0x${string}`,
  data: '0x1234' as Hex, value: 0n, gas: 300_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n };
// Stands in for Privy's REST API: signs the requested fields with `signer`, optionally altering them.
function fakePrivy(signer = key, alter: (t: typeof tx) => typeof tx = t => t) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls.push({ url, headers: init.headers as Record<string, string>, body });
    if (url.endsWith('/v1/wallets')) return Response.json({ id: 'wallet-1', address: key.address.toLowerCase() });
    const t = body.params.transaction;
    const request = alter({ type: 'eip1559', chainId: Number(t.chain_id), nonce: Number(t.nonce), to: t.to, data: t.data, value: hexToBigInt(t.value),
      gas: hexToBigInt(t.gas_limit), maxFeePerGas: hexToBigInt(t.max_fee_per_gas), maxPriorityFeePerGas: hexToBigInt(t.max_priority_fee_per_gas) });
    return Response.json({ method: 'eth_signTransaction', data: { signed_transaction: await signer.signTransaction(request), encoding: 'rlp' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, credentials: { appId: 'app-id', appSecret: 'app-secret', fetch } };
}

test('Privy server wallet signs the exact requested transaction with app-secret auth', async () => {
  const privy = fakePrivy(), account = privyAccount(privy.credentials, 'wallet-1', key.address);
  assert.equal(await account.signTransaction(tx), await key.signTransaction(tx));
  const call = privy.calls[0]!;
  assert.equal(call.url, 'https://api.privy.io/v1/wallets/wallet-1/rpc');
  assert.equal(call.headers['privy-app-id'], 'app-id');
  assert.equal(call.headers.Authorization, `Basic ${Buffer.from('app-id:app-secret').toString('base64')}`);
  assert.equal(call.body.method, 'eth_signTransaction');
  await assert.rejects(account.signMessage({ message: 'hi' }));
});
test('Privy signatures from another key or over altered fields are rejected', async () => {
  await assert.rejects(privyAccount(fakePrivy(other).credentials, 'wallet-1', key.address).signTransaction(tx), /does not match/);
  await assert.rejects(privyAccount(fakePrivy(key, t => ({ ...t, to: other.address })).credentials, 'wallet-1', key.address).signTransaction(tx), /does not match/);
  await assert.rejects(privyAccount(fakePrivy(key, t => ({ ...t, value: 1n })).credentials, 'wallet-1', key.address).signTransaction(tx), /does not match/);
});
test('Privy wallet creation returns the checksummed operator address', async () => {
  assert.deepEqual(await createPrivyServerWallet(fakePrivy().credentials), { id: 'wallet-1', address: key.address });
});
test('broadcast config selects a Privy operator only with complete, unambiguous settings', async () => {
  const env = { PRIPO_MCP_RPC_URL: 'http://localhost:8545', PRIPO_MCP_OWNER: other.address, PRIPO_MCP_OPERATOR_ADDRESS: key.address,
    PRIVY_APP_ID: 'app-id', PRIVY_APP_SECRET: 'secret', PRIPO_MCP_PRIVY_WALLET_ID: 'wallet-1' };
  const loaded = await loadConfig(['--broadcast'], env);
  assert.equal(loaded.account?.address, key.address); assert.equal(loaded.config.operator, key.address);
  await assert.rejects(loadConfig(['--broadcast'], { ...env, PRIVY_APP_SECRET: '' }));
  await assert.rejects(loadConfig(['--broadcast'], { ...env, PRIPO_MCP_OPERATOR_ADDRESS: undefined }));
  await assert.rejects(loadConfig(['--broadcast'], { ...env, PRIPO_MCP_OPERATOR_PRIVATE_KEY: `0x${'33'.repeat(32)}` }));
  await assert.rejects(loadConfig(['--broadcast'], { ...env, PRIPO_MCP_OWNER: key.address }));
  assert.equal((await loadConfig([], env)).account, undefined);
});
