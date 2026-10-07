import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createServer } from 'node:net';
import { basename, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient, createWalletClient, encodeFunctionData, http, zeroHash,
  type Abi, type Address, type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { createPripoClient, WAD } from '@pripo/sdk';
import { marginVaultAbi } from '@pripo/sdk/abis';

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex; linkReferences: Record<string, Record<string, { start: number; length: number }[]>> };
}

test('stdio MCP with real contracts: delegated trading, exact policy rejection, retries, restart and operator-funded creation',
  { timeout: 120_000 }, async () => {
    assert.ok(process.env.PRIPO_CONTRACTS, 'Set PRIPO_CONTRACTS to a built checkout of the pinned contracts revision');
    const contracts = resolve(process.env.PRIPO_CONTRACTS);
    const manifest = JSON.parse(await readFile(new URL('../abi-manifest.json', import.meta.url), 'utf8'));
    execFileSync('git', ['-C', contracts, 'diff', '--exit-code', manifest.commit, '--', 'src', 'lib', 'foundry.toml', 'test/helpers/MockUSDC.sol'], { stdio: 'pipe' });
    execFileSync('forge', ['build'], { cwd: contracts, stdio: 'pipe' });
    const temporary = await mkdtemp(resolve(tmpdir(), 'pripo-mcp-e2e-'));

    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done, reject) => reservation.close((error) => error ? reject(error) : done()));
    const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent', '--hardfork', 'cancun'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let startupError: Error | undefined;
    let stderr = '';
    anvil.on('error', (error) => { startupError = error; });
    anvil.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const publicClient = createPublicClient({ chain: foundry, transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 }),
      pollingInterval: 10, cacheTime: 0 });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (startupError) throw startupError;
        if (anvil.exitCode !== null) throw new Error(`Anvil exited: ${stderr}`);
        try { await publicClient.getChainId(); ready = true; break; } catch { await delay(100); }
      }
      assert.ok(ready, 'Anvil did not start');
      const addresses = await createWalletClient({ chain: foundry,
        transport: http(`http://127.0.0.1:${port}`) }).getAddresses();
      const owner = addresses[0]!;
      // Anvil's public test mnemonic, used only with this test's freshly spawned local node.
      const operatorAccount = mnemonicToAccount('test test test test test test test test test test test junk',
        { addressIndex: 1 });
      const operator = operatorAccount.address;
      assert.equal(operator.toLowerCase(), addresses[1]!.toLowerCase());
      const walletClient = createWalletClient({ chain: foundry, account: owner,
        transport: http(`http://127.0.0.1:${port}`) });
      const receipt = async (hash: Hex) => {
        const result = await publicClient.waitForTransactionReceipt({ hash });
        assert.equal(result.status, 'success');
        return result;
      };
      const artifact = async (file: string, name: string): Promise<Artifact> =>
        JSON.parse(await readFile(resolve(contracts, 'out', basename(file), `${name}.json`), 'utf8'));
      const libraries = new Map<string, Address>();
      const deploy = async (file: string, name: string, args: readonly unknown[] = []): Promise<Address> => {
        const build = await artifact(file, name);
        let code = build.bytecode.object.replace(/^0x/, '');
        for (const [source, names] of Object.entries(build.bytecode.linkReferences)) {
          for (const [library, refs] of Object.entries(names)) {
            const key = `${source}:${library}`;
            let address = libraries.get(key);
            if (!address) { address = await deploy(source, library); libraries.set(key, address); }
            for (const ref of refs) {
              assert.equal(ref.length, 20);
              code = code.slice(0, ref.start * 2) + address.slice(2) + code.slice((ref.start + ref.length) * 2);
            }
          }
        }
        const mined = await receipt(await walletClient.deployContract({ abi: build.abi, bytecode: `0x${code}`, args }));
        assert.ok(mined.contractAddress);
        return mined.contractAddress;
      };
      const usdc = await deploy('MockUSDC.sol', 'MockUSDC');
      const implementation = await deploy('MarginVault.sol', 'MarginVault');
      const vault = await deploy('ERC1967Proxy.sol', 'ERC1967Proxy', [implementation,
        encodeFunctionData({ abi: marginVaultAbi, functionName: 'initialize', args: [usdc, owner, owner, owner] })]);
      const nullAdapter = await deploy('NullAdapter.sol', 'NullAdapter');
      const marketImplementation = await deploy('Market.sol', 'Market');
      const factory = await deploy('MarketFactory.sol', 'MarketFactory', [vault, marketImplementation, nullAdapter, true]);
      const usdcAbi = (await artifact('MockUSDC.sol', 'MockUSDC')).abi;
      await receipt(await walletClient.writeContract({ address: usdc, abi: usdcAbi,
        functionName: 'mint', args: [owner, 20_000_000_000n] }));
      await receipt(await walletClient.writeContract({ address: usdc, abi: usdcAbi,
        functionName: 'approve', args: [vault, 10_000_000_000n] }));
      await receipt(await walletClient.writeContract({ address: vault, abi: marginVaultAbi,
        functionName: 'fundProtocolReserve', args: [10_000_000_000n] }));
      await receipt(await walletClient.writeContract({ address: vault, abi: marginVaultAbi,
        functionName: 'setRegistrar', args: [factory, true] }));

      const sdk = createPripoClient({ publicClient, walletClient, chain: foundry, vault, factory });
      await receipt(await sdk.approveSeedBond(2_000_000_000n));
      await receipt(await sdk.createMarket({ symbol: 'PRIPO:MCP-TEST', priceSource: nullAdapter, feedId: zeroHash,
        initialPrice: 100n * WAD, depth: 2_000_000n * WAD, seedBond: 2_000_000_000n }));
      const list = await sdk.listMarkets();
      assert.equal(list.markets.length, 1);
      const market = sdk.market(list.markets[0]!);
      await receipt(await sdk.vault.approveDeposit(500_000_000n));
      await receipt(await sdk.vault.deposit(500_000_000n));
      assert.equal(await sdk.vault.freeBalance(owner), 500n * WAD);
      await receipt(await sdk.vault.setOperator(operator, { expiry: (await publicClient.getBlockNumber({ cacheTime: 0 })) + 500n,
        maxNotionalPerTx: 150n * WAD, maxTotalNotional: 150n * WAD, marketsRoot: zeroHash, canClose: true }));
      // Creation approval is provisioned outside MCP; it belongs to the operator wallet.
      await receipt(await walletClient.writeContract({ address: usdc, abi: usdcAbi,
        functionName: 'mint', args: [operator, 2_000_000_000n] }));
      const operatorWallet = createWalletClient({ chain: foundry, account: operatorAccount,
        transport: http(`http://127.0.0.1:${port}`) });
      await receipt(await operatorWallet.writeContract({ address: usdc, abi: usdcAbi,
        functionName: 'approve', args: [factory, 2_000_000_000n] }));
      const deployment = { chainId: 31337, chainName: 'Anvil', nativeSymbol: 'ETH', factory, vault, pythAdapters: [],
        confirmations: 1, maxGas: '3000000', maxFeePerGas: '100000000000', maxNativeValue: '10000000000000000',
        maxCreationSeedBondUsdc: '2000000000' };
      const configPath = resolve(temporary, 'deployment.json');
      await writeFile(configPath, JSON.stringify(deployment));
      const connect = async () => {
        const transport = new StdioClientTransport({ command: process.execPath,
          args: ['dist/cli.js', '--config', configPath, '--broadcast'], cwd: process.cwd(), stderr: 'pipe',
          env: { PRIPO_MCP_RPC_URL: `http://127.0.0.1:${port}`, PRIPO_MCP_OWNER: owner,
            PRIPO_MCP_OPERATOR_PRIVATE_KEY: operatorAccount.getHdKey().privateKey
              ? `0x${Buffer.from(operatorAccount.getHdKey().privateKey!).toString('hex')}` : '',
            PRIPO_MCP_STATE_PATH: resolve(temporary, 'transactions.json') } });
        let errors = ''; transport.stderr?.on('data', data => { errors += String(data); });
        const client = new Client({ name: 'pripo-e2e', version: '1' });
        try { await client.connect(transport); } catch (e) { await transport.close(); throw new Error(`MCP startup failed: ${errors}`, { cause: e }); }
        return client;
      };
      let client = await connect();
      const call = async (name: string, args: Record<string, unknown> = {}, error?: string): Promise<Record<string, any>> => {
        const response = await client.callTool({ name, arguments: args });
        const data = response.structuredContent as { ok: boolean; result: Record<string, any>; error: { code: string } };
        if (error) { assert.equal(response.isError, true); assert.equal(data.error.code, error); return data.error; }
        assert.equal(data.ok, true, JSON.stringify(data)); return data.result;
      };
      const openArgs = { market: market.address, size: WAD.toString(), limit_price: (101n * WAD).toString(), request_id: 'open-first' };
      try {
        assert.equal((await client.listTools()).tools.length, 16);
        assert.equal((await call('get_protocol')).mode, 'broadcast');
        assert.equal((await call('list_markets')).total, '1');
        assert.equal((await call('quote_open', { market: market.address, size: WAD.toString() })).executableGuarantee, false);
        const preview = await call('prepare_open', { market: market.address, size: WAD.toString(), limit_price: (101n * WAD).toString() });
        assert.equal(preview.functionName, 'openFor'); assert.equal(preview.request.account.toLowerCase(), operator.toLowerCase());
        const opened = await call('open_position', openArgs); await receipt(opened.transactionHash as Hex);
        assert.equal((await call('get_transaction_status', { request_id: 'open-first' })).status, 'confirmed');
        assert.equal((await market.position(owner)).size, WAD);
        assert.equal((await call('get_positions')).positions[0].size, WAD.toString());
        assert.equal((await call('get_book', { market: market.address })).positions.length, 1);
        assert.equal((await call('get_health', { market: market.address })).liquidatable, false);
        const nonce = await publicClient.getTransactionCount({ address: operator });
        assert.equal((await call('open_position', openArgs)).transactionHash, opened.transactionHash);
        await call('open_position', { ...openArgs, size: '2' }, 'IDEMPOTENCY_CONFLICT');
        await client.close(); client = await connect();
        assert.equal((await call('open_position', openArgs)).transactionHash, opened.transactionHash);
        assert.equal(await publicClient.getTransactionCount({ address: operator }), nonce);
        const perTx = await call('open_position', { ...openArgs, size: (2n * WAD).toString(), limit_price: (102n * WAD).toString(), request_id: 'over-policy' }, 'POLICY_VIOLATION');
        assert.equal(perTx.details.args[0], 4);
        assert.equal(await publicClient.getTransactionCount({ address: operator }), nonce);
        const closeArgs = { market: market.address, size_fraction: WAD.toString(), limit_price: (99n * WAD).toString() };
        const cumulative = await call('close_position', { ...closeArgs, request_id: 'over-total' }, 'POLICY_VIOLATION');
        assert.equal(cumulative.details.args[0], 5);
        const policy = { expiry: (await publicClient.getBlockNumber({ cacheTime: 0 })) + 500n,
          maxNotionalPerTx: 150n * WAD, maxTotalNotional: 500n * WAD, marketsRoot: zeroHash, canClose: true };
        await receipt(await sdk.vault.setOperator(operator, { ...policy, canClose: false }));
        await call('close_position', { ...closeArgs, request_id: 'close-disabled' }, 'POLICY_VIOLATION');
        await receipt(await sdk.vault.setOperator(operator, { ...policy, marketsRoot: `0x${'11'.repeat(32)}` }));
        const proofError = await call('close_position', { ...closeArgs, request_id: 'missing-proof' }, 'POLICY_VIOLATION');
        assert.equal(proofError.details.args[0], 3);
        await receipt(await sdk.vault.setOperator(operator, policy));
        const closed = await call('close_position', { market: market.address, size_fraction: WAD.toString(),
          limit_price: (99n * WAD).toString(), request_id: 'close-first' });
        await receipt(closed.transactionHash as Hex);
        assert.equal((await call('get_transaction_status', { request_id: 'close-first' })).status, 'confirmed');
        assert.equal((await market.position(owner)).size, 0n);
        await receipt(await sdk.vault.revokeOperator(operator));
        await call('open_position', { ...openArgs, request_id: 'revoked' }, 'POLICY_VIOLATION');
        const creation = { symbol: 'PRIPO:MCP-CREATED', price_source: nullAdapter, feed_id: zeroHash,
          initial_price: (100n * WAD).toString(), depth: (2_000_000n * WAD).toString(), seed_bond_usdc: '2000000000' };
        const creationPreview = await call('prepare_create_market', creation);
        assert.equal(creationPreview.creator.toLowerCase(), operator.toLowerCase());
        await call('create_market', { ...creation, seed_bond_usdc: '2000000001', request_id: 'over-creation-cap' }, 'CREATION_LIMIT');
        const created = await call('create_market', { ...creation, request_id: 'create-first' });
        await receipt(created.transactionHash as Hex);
        assert.equal((await sdk.listMarkets()).markets.length, 2);
        assert.equal((await sdk.market(creationPreview.predictedAddress).config()).creator.toLowerCase(), operator.toLowerCase());
        console.log('Verified stdio MCP: open, close, exact policy rejection, idempotency across restart, revocation, and capped operator-funded creation');
      } finally { await client.close(); }
    } finally {
      anvil.kill('SIGTERM');
      if (anvil.pid && anvil.exitCode === null) await new Promise<void>((done) => anvil.once('exit', () => done()));
    }
  });
