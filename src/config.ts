import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineChain, getAddress, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { ToolError } from './errors.js';

export const addressSchema = z.string().refine(value => isAddress(value, { strict: false }), 'Expected an EVM address').transform(value => getAddress(value));
export const uintSchema = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine(value => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) < 2n ** 256n, 'Expected uint256');
export const signedSchema = z.string().max(79).regex(/^-?[1-9][0-9]*$/).refine(value => /^-?[1-9][0-9]*$/.test(value) && value.length <= 79 && BigInt(value) >= -(2n ** 255n) && BigInt(value) < 2n ** 255n, 'Expected nonzero int256');
const deploymentSchema = z.strictObject({
  chainId: z.number().int().positive().safe(), chainName: z.string().min(1), nativeSymbol: z.string().min(1),
  factory: addressSchema, vault: addressSchema, pythAdapters: z.array(addressSchema).max(20),
  confirmations: z.number().int().min(1).max(100), maxGas: uintSchema, maxFeePerGas: uintSchema,
  maxNativeValue: uintSchema, maxCreationSeedBondUsdc: uintSchema,
});
export type Deployment = z.infer<typeof deploymentSchema>;
export type Config = Deployment & { rpcUrl: string; indexerUrl?: string; owner?: Address; operator?: Address; broadcast: boolean; statePath: string };

export async function loadConfig(args: string[], env: NodeJS.ProcessEnv = process.env) {
  let broadcast = false;
  let file: string | URL = new URL('../config/monad-testnet.json', import.meta.url);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || (arg !== '--broadcast' && arg !== '--config')) throw new ToolError('CONFIGURATION', 'Usage: pripo-mcp [--config path.json] [--broadcast]');
    seen.add(arg);
    if (arg === '--broadcast') broadcast = true;
    else {
      const path = args[++i];
      if (!path || path.startsWith('--')) throw new ToolError('CONFIGURATION', '--config requires a JSON file path.');
      file = path;
    }
  }
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new ToolError('CONFIGURATION', 'Cannot read deployment configuration JSON.'); }
  const parsed = deploymentSchema.safeParse(raw);
  if (!parsed.success) throw new ToolError('CONFIGURATION', 'Deployment configuration is invalid. Check required addresses and integer bounds.');
  const rpcUrl = env.PRIPO_MCP_RPC_URL;
  if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) throw new ToolError('CONFIGURATION', 'Set PRIPO_MCP_RPC_URL to an HTTP RPC endpoint.');
  for (const url of [rpcUrl, env.PRIPO_MCP_INDEXER_URL].filter(Boolean)) {
    try { if (!['http:', 'https:'].includes(new URL(url!).protocol)) throw new Error(); }
    catch { throw new ToolError('CONFIGURATION', 'RPC and indexer endpoints must be valid HTTP URLs.'); }
  }
  const owner = env.PRIPO_MCP_OWNER ? addressSchema.parse(env.PRIPO_MCP_OWNER) : undefined;
  let operator = env.PRIPO_MCP_OPERATOR_ADDRESS ? addressSchema.parse(env.PRIPO_MCP_OPERATOR_ADDRESS) : undefined;
  // A key present in the environment is deliberately ignored in read-only mode.
  let account;
  if (broadcast) {
    const key = env.PRIPO_MCP_OPERATOR_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key) || !owner) throw new ToolError('CONFIGURATION', 'Broadcast mode requires an owner and a dedicated operator key.');
    account = privateKeyToAccount(key as `0x${string}`);
    if (operator && operator !== account.address) throw new ToolError('CONFIGURATION', 'Configured operator address does not match the key.');
    operator = account.address;
    if (operator === owner) throw new ToolError('CONFIGURATION', 'Use a delegated operator distinct from the position owner.');
  }
  const config: Config = { ...parsed.data, rpcUrl, owner, operator, broadcast, indexerUrl: env.PRIPO_MCP_INDEXER_URL,
    statePath: resolve(env.PRIPO_MCP_STATE_PATH ?? '.state/transactions.json') };
  const chain = defineChain({ id: config.chainId, name: config.chainName, nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  return { config, chain, account };
}
