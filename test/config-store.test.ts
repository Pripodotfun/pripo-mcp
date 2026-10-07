import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, signedSchema, uintSchema } from '../src/config.js';
import { FileStore } from '../src/store.js';
import { config } from './helpers.js';

test('read-only mode ignores private keys and rejects invalid CLI arguments', async () => {
  const env = { PRIPO_MCP_RPC_URL: 'http://localhost:8545', PRIPO_MCP_OPERATOR_PRIVATE_KEY: 'invalid-key' };
  const loaded = await loadConfig([], env); assert.equal(loaded.account, undefined); assert.equal(loaded.config.broadcast, false);
  for (const args of [['unknown'], ['--config'], ['--config', '--broadcast'], ['--broadcast', '--broadcast']]) {
    await assert.rejects(loadConfig(args, env));
  }
  await assert.rejects(loadConfig(['--broadcast'], env));
  await assert.rejects(loadConfig([], { ...env, PRIPO_MCP_INDEXER_URL: 'file:///etc/passwd' }));
});
test('integer validation rejects malformed, imprecise and out-of-range inputs without throwing', () => {
  for (const value of ['1.1', '1e18', '01', '-0', 'x', '0x12', '9'.repeat(90), 1e18, '']) {
    assert.equal(uintSchema.safeParse(value).success, false); assert.equal(signedSchema.safeParse(value).success, false);
  }
  assert.equal(uintSchema.safeParse((2n ** 256n).toString()).success, false);
  assert.equal(signedSchema.safeParse((2n ** 255n).toString()).success, false);
  assert.equal(signedSchema.safeParse('-1000000000000000001').success, true);
});
test('broadcast rejects using the owner key as an operator', async () => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const key = `0x${'11'.repeat(32)}` as const;
  await assert.rejects(loadConfig(['--broadcast'], { PRIPO_MCP_RPC_URL: config.rpcUrl,
    PRIPO_MCP_OWNER: privateKeyToAccount(key).address, PRIPO_MCP_OPERATOR_PRIVATE_KEY: key }), /distinct/);
});
test('journal locks exclusively, persists privately, releases and fails closed on corruption or identity mismatch', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'pripo-mcp-store-')), 'state.json');
  const store = await FileStore.open(file, 'identity');
  try {
    await assert.rejects(FileStore.open(file, 'identity'));
    await store.save(); assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
  } finally { await store.close(); }
  await assert.rejects(FileStore.open(file, 'other'), /identity/);
  const reopened = await FileStore.open(file, 'identity'); await reopened.close();
  await writeFile(file, '{broken'); await assert.rejects(FileStore.open(file, 'identity'), /invalid/);
});
