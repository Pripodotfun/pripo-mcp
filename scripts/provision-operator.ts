import assert from 'node:assert/strict';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { marginVaultAbi } from '@pripo/sdk/abis';
import type { PreparedTransaction } from '@pripo/sdk';
import { loadConfig } from '../src/config.js';
import { PripoService } from '../src/service.js';
import { FileStore } from '../src/store.js';
import { Transactions } from '../src/transactions.js';
import { json, publicError } from '../src/errors.js';

// Deliberately restricted to this testnet deployment and its existing demo market.
const market = '0xeA326A40694dA4D7C5c64719B48Ba561EcA8C0Eb';
const owner = '0x3b2F1773a1B279A1b0b13aD425019C91433693c3';
const vault = '0x1980B3a41393f610a8BE552C71BAE3F42AAB6735';
const fundingTarget = 100_000_000_000_000_000n; // 0.1 testnet MON, once per plan.
const maxNotionalPerTx = 150n * 10n ** 18n;
const maxTotalNotional = 500n * 10n ** 18n;
const marketRoot = keccak256(keccak256(encodeAbiParameters([{ type: 'address' }], [market])));
type Plan = { chainId: number; owner: string; operator: string; vault: string; market: string;
  preparedBlock: string; expiry: string; maxNotionalPerTx: string; maxTotalNotional: string;
  marketsRoot: string; canClose: boolean; fundingWei: string };

let store: FileStore | undefined;
try {
  const mode = process.argv[2];
  assert.ok(process.argv.length === 3 && (mode === '--prepare' || mode === '--broadcast'), 'Use --prepare or --broadcast');
  // Validate the new operator's key/address pair before funding it. Signing below
  // still uses only the owner key and only in the explicit broadcast branch.
  const { config, chain } = await loadConfig(['--broadcast']);
  assert.equal(config.chainId, 10143); assert.equal(config.vault.toLowerCase(), vault.toLowerCase());
  assert.equal(config.owner?.toLowerCase(), owner.toLowerCase());
  assert.ok(config.operator && config.operator.toLowerCase() !== owner.toLowerCase(), 'Configure a dedicated operator first');
  const service = PripoService.connect(config, chain); await service.verifyDeployment();
  const rpc = service.sdk.publicClient;
  const identity = ['provision', config.chainId, vault, owner, config.operator].join(':').toLowerCase();
  store = await FileStore.open(resolve('.state/operator-provisioning.json'), identity);
  const planPath = resolve('.state/operator-plan.json');
  let plan: Plan;
  try { plan = JSON.parse(await readFile(planPath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    assert.equal(mode, '--prepare', 'Run --prepare before broadcasting');
    const [block, balance, existingPolicy] = await Promise.all([
      rpc.getBlockNumber({ cacheTime: 0 }), rpc.getBalance({ address: config.operator }),
      service.sdk.vault.operator(owner, config.operator),
    ]);
    assert.equal(existingPolicy.expiry, 0n, 'An existing policy must not be reset by provisioning');
    plan = { chainId: 10143, owner, operator: config.operator, vault, market, preparedBlock: block.toString(),
      expiry: (block + 100_000n).toString(), maxNotionalPerTx: maxNotionalPerTx.toString(),
      maxTotalNotional: maxTotalNotional.toString(), marketsRoot: marketRoot, canClose: true,
      fundingWei: (balance < fundingTarget ? fundingTarget - balance : 0n).toString() };
    const file = await open(planPath, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(plan, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  }
  assert.equal(plan.chainId, 10143); assert.equal(plan.owner, owner); assert.equal(plan.operator, config.operator);
  assert.equal(plan.vault, vault); assert.equal(plan.market, market); assert.equal(plan.marketsRoot, marketRoot);
  assert.equal(plan.maxNotionalPerTx, maxNotionalPerTx.toString()); assert.equal(plan.maxTotalNotional, maxTotalNotional.toString());
  assert.equal(plan.canClose, true); assert.equal(BigInt(plan.expiry), BigInt(plan.preparedBlock) + 100_000n);
  assert.ok(BigInt(plan.fundingWei) >= 0n && BigInt(plan.fundingWei) <= fundingTarget);
  const policy = { expiry: BigInt(plan.expiry), maxNotionalPerTx, maxTotalNotional, usedNotional: 0n, marketsRoot: marketRoot, canClose: true };
  const ownerSdk = PripoService.connect({ ...config, operator: owner }, chain).sdk;
  const prepareGrant = async () => {
    const current = await service.sdk.vault.operator(owner, config.operator!);
    assert.equal(current.expiry, 0n, 'Refusing to overwrite an existing operator policy');
    assert.ok(policy.expiry > await rpc.getBlockNumber({ cacheTime: 0 }), 'Prepared policy has expired');
    return ownerSdk.prepare({ address: vault, abi: marginVaultAbi, functionName: 'setOperator', args: [config.operator!, policy] }, await ownerSdk.block());
  };
  const prepareFunding = async (): Promise<PreparedTransaction> => {
    const value = BigInt(plan.fundingWei);
    const gas = await rpc.estimateGas({ account: owner, to: config.operator, value });
    return { blockNumber: await ownerSdk.block(), functionName: 'fundOperatorGas', request: {
      chainId: 10143, account: owner, to: config.operator!, data: '0x' as Hex, value, gas: gas + 10_000n,
    } };
  };
  if (mode === '--prepare') {
    const grant = await prepareGrant();
    const funding = BigInt(plan.fundingWei) ? await prepareFunding() : undefined;
    console.log(JSON.stringify(json({ plan, grant, funding }), null, 2));
  } else {
    // The owner key is read only for this explicit provisioning command, never by the MCP server.
    assert.ok(process.env.PRIPO_OWNER_ENV_FILE, 'Set PRIPO_OWNER_ENV_FILE to the local owner environment file');
    const ownerEnv = parseEnv(await readFile(process.env.PRIPO_OWNER_ENV_FILE, 'utf8'));
    const ownerAccount = privateKeyToAccount(ownerEnv.FUNDED_DEPLOYER_PRIVATE_KEY as Hex);
    assert.equal(ownerAccount.address.toLowerCase(), owner.toLowerCase(), 'Owner key mismatch');
    const transactions = new Transactions(rpc, { ...config, maxNativeValue: fundingTarget.toString() }, store, ownerAccount);
    await transactions.initialize();
    const settle = async (id: string, input: unknown, prepare: Parameters<Transactions['submit']>[2]) => {
      console.log(JSON.stringify(await transactions.submit(id, input, prepare)));
      for (let i = 0; i < 60; i++) {
        const result = await transactions.status(id);
        if (result.status === 'confirmed') return result;
        assert.notEqual(result.status, 'reverted', 'Provisioning transaction reverted');
        await delay(1000);
      }
      throw new Error('Receipt not confirmed yet; rerun with the same persisted plan');
    };
    const funded = BigInt(plan.fundingWei) ? await settle('fund-operator-gas', { plan, operation: 'fund' }, prepareFunding) : undefined;
    const granted = await settle('grant-operator-policy', { plan, operation: 'grant' }, prepareGrant);
    const verified = await service.operatorPolicy();
    assert.equal(verified.policy.marketsRoot, marketRoot); assert.equal(verified.policy.expiry, policy.expiry);
    assert.equal(verified.policy.maxNotionalPerTx, maxNotionalPerTx); assert.equal(verified.policy.maxTotalNotional, maxTotalNotional);
    assert.equal(verified.policy.canClose, true);
    await writeFile('docs/operator-setup.json', JSON.stringify(json({ completedAt: new Date().toISOString(), plan,
      funding: funded, grant: granted, policy: verified,
      operatorBalanceWei: await rpc.getBalance({ address: config.operator! }), positionTradesSent: 0 }), null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, report: 'docs/operator-setup.json', operator: config.operator }));
  }
} catch (error) {
  console.error(JSON.stringify(json(error instanceof assert.AssertionError
    ? { code: 'PROVISIONING_CHECK', message: error.message } : publicError(error))));
  process.exitCode = 1;
} finally { await store?.close(); }
