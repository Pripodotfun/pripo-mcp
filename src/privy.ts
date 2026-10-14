import { getAddress, isAddressEqual, parseTransaction, recoverTransactionAddress, toHex, type Address, type Hex, type TransactionSerializable } from 'viem';
import { toAccount } from 'viem/accounts';
import { z } from 'zod';
import { ToolError } from './errors.js';

// Privy server wallets: Privy holds the operator key and signs over its REST API with the app secret.
// The vault's onchain operator limits remain the enforcement; this only moves custody of the key.
export type PrivyCredentials = { appId: string; appSecret: string; apiUrl?: string; fetch?: typeof fetch };

async function privy(credentials: PrivyCredentials, path: string, body: unknown) {
  const response = await (credentials.fetch ?? fetch)(`${credentials.apiUrl ?? 'https://api.privy.io'}${path}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', 'privy-app-id': credentials.appId,
      Authorization: `Basic ${Buffer.from(`${credentials.appId}:${credentials.appSecret}`).toString('base64')}` },
    body: JSON.stringify(body),
  });
  // Privy error bodies can echo request details; report only the status.
  if (!response.ok) throw new ToolError('SIGNER_UNAVAILABLE', `Privy request failed with HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

export async function createPrivyServerWallet(credentials: PrivyCredentials) {
  const wallet = z.object({ id: z.string().min(1), address: z.string() }).parse(await privy(credentials, '/v1/wallets', { chain_type: 'ethereum' }));
  return { id: wallet.id, address: getAddress(wallet.address) };
}

const signed = z.object({ data: z.object({ signed_transaction: z.string().regex(/^0x[0-9a-fA-F]+$/) }) });
const same = (a: unknown, b: unknown) => (a ?? 0n) === (b ?? 0n);

export function privyAccount(credentials: PrivyCredentials, walletId: string, address: Address) {
  return toAccount({
    address,
    async signTransaction(tx: TransactionSerializable) {
      if (tx.type !== 'eip1559' || !tx.to || tx.chainId === undefined || tx.nonce === undefined || tx.gas === undefined
        || tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined) throw new ToolError('SIGNER_MISMATCH', 'Privy signing requires a complete EIP-1559 transaction.');
      const result = signed.parse(await privy(credentials, `/v1/wallets/${encodeURIComponent(walletId)}/rpc`, { method: 'eth_signTransaction', params: { transaction: {
        type: 2, chain_id: toHex(tx.chainId), nonce: toHex(tx.nonce), to: tx.to, data: tx.data ?? '0x', value: toHex(tx.value ?? 0n),
        gas_limit: toHex(tx.gas), max_fee_per_gas: toHex(tx.maxFeePerGas), max_priority_fee_per_gas: toHex(tx.maxPriorityFeePerGas) } } }));
      const raw = result.data.signed_transaction as Hex, parsed = parseTransaction(raw);
      // Never broadcast bytes that differ from the request or were signed by another key.
      if (parsed.type !== 'eip1559' || parsed.chainId !== tx.chainId || parsed.nonce !== tx.nonce || !parsed.to || !isAddressEqual(parsed.to, tx.to)
        || (parsed.data ?? '0x') !== (tx.data ?? '0x') || !same(parsed.value, tx.value) || parsed.gas !== tx.gas
        || parsed.maxFeePerGas !== tx.maxFeePerGas || parsed.maxPriorityFeePerGas !== tx.maxPriorityFeePerGas
        || !isAddressEqual(await recoverTransactionAddress({ serializedTransaction: raw as never }), address))
        throw new ToolError('SIGNER_MISMATCH', 'Privy returned a transaction that does not match the request or signer.');
      return raw as never;
    },
    async signMessage() { throw new ToolError('SIGNER_MISMATCH', 'The operator wallet only signs transactions.'); },
    async signTypedData() { throw new ToolError('SIGNER_MISMATCH', 'The operator wallet only signs transactions.'); },
  });
}
