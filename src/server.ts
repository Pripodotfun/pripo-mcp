import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { addressSchema, signedSchema, uintSchema } from './config.js';
import { json, publicError, ToolError } from './errors.js';
import type { PripoService } from './service.js';

const positive = uintSchema.refine(v => v !== '0', 'Must be positive');
const fraction = positive.refine(v => /^[0-9]+$/.test(v) && BigInt(v) <= 10n ** 18n, 'Fraction must be at most 1e18');
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const proof = z.array(bytes32).max(64).default([]).describe('Merkle siblings for the operator market allowlist; empty for an unrestricted policy.');
const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).describe('Unique intent ID. Reuse this exact ID and arguments on retries, including after timeout or restart.');
const market = addressSchema.describe('Market deployed by the configured Pripo factory.');
const user = addressSchema.optional().describe('Read address; defaults to the configured position owner.');
const page = { offset: uintSchema.default('0'), limit: z.number().int().min(1).max(50).default(20) };
const open = { market, size: signedSchema.describe('Signed WAD size: positive long, negative short.'), limit_price: positive.describe('WAD maximum buy or minimum sell price.'), market_proof: proof };
const close = { market, size_fraction: fraction.describe('Fraction of the position in WAD; 1e18 closes fully.'), limit_price: positive, market_proof: proof };
const create = { symbol: z.string().min(1).max(64), price_source: addressSchema, feed_id: bytes32,
  initial_price: positive, depth: positive, seed_bond_usdc: positive.describe('Raw 6-decimal collateral units paid from the operator wallet.') };

export function createServer(service: PripoService) {
  const server = new McpServer({ name: 'pripo-mcp', version: '0.1.0' }, {
    instructions: 'Pripo tools use integer strings for amounts: WAD has 18 decimals; seed bonds have 6. Reads carry block provenance. Quotes are indicative. Trading uses the fixed configured owner and a delegated operator. Reuse request_id after any uncertain submission; never change it to retry. Check get_transaction_status for confirmation. Market creation uses the operator wallet and a separate opt-in cap. Settlement is not implemented.',
  });
  function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S,
    action: (args: z.output<z.ZodObject<S>>, ctx: ServerContext) => unknown | Promise<unknown>, write = false) {
    server.registerTool(name, { description, inputSchema: z.strictObject(shape),
      annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: true, openWorldHint: true } },
    async (args, ctx): Promise<CallToolResult> => {
      try {
        const structuredContent = json({ ok: true, result: await action(args, ctx) });
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
      } catch (error) {
        const structuredContent = json({ ok: false, error: publicError(error) });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
      }
    });
  }
  tool('get_protocol', 'Read configured deployment, units, mode and supported capabilities.', {}, () => service.info());
  tool('list_markets', 'Page through factory markets at a consistent RPC block.', page, a => service.listMarkets(a.offset, a.limit));
  tool('get_market', 'Read market configuration, prices, open interest, funding and vault ledger.', { market }, a => service.market(a.market));
  tool('get_book', 'Read exact position book from RPC (default), or an indexed snapshot with age and canonical-block checks. Indexed books are never execution quotes.',
    { market, source: z.enum(['rpc', 'indexer']).default('rpc'), max_age_seconds: z.number().int().min(0).max(31_536_000).default(60) }, a => service.book(a.market, a.source, a.max_age_seconds));
  tool('get_positions', 'Read positions and free collateral; pagination scans factory markets, including empty ones.',
    { user, market: market.optional(), ...page }, a => service.positions(a.user, a.market, a.offset, a.limit));
  tool('get_health', 'Read equity/entry-notional health ratio, liquidatability, liquidation reference/reason and pending ADL.', { market, user }, a => service.health(a.market, a.user));
  tool('quote_open', 'Indicative open quote at a fresh block. External oracle updates and execution can change the result.', { market, user, size: signedSchema }, a => service.quoteOpen(a.market, a.user, a.size));
  tool('quote_close', 'Indicative close quote at a fresh block.', { market, user, size_fraction: fraction }, a => service.quoteClose(a.market, a.user, a.size_fraction));
  tool('get_operator_policy', 'Read the fixed owner/operator policy, usage and block expiry.', {}, () => service.operatorPolicy());
  tool('prepare_open', 'Simulate delegated opening with fresh oracle updates, policy and proof checks. Returns unsigned calldata; does not reserve a quote.', open, a => service.prepareOpen(a));
  tool('prepare_close', 'Simulate delegated close with policy and proof checks. No external oracle update is required.', close, a => service.prepareClose(a));
  tool('prepare_create_market', 'Simulate creation funded and owned by the operator. Requires explicit creation cap; owner trading policy does not apply.', create, a => service.prepareCreation(a));
  tool('open_position', 'Submit a delegated open after fresh simulation. Requires broadcast mode and a unique request_id. Submission is not confirmation.',
    { ...open, request_id: requestId }, ({ request_id, ...a }, ctx) => service.write('open', request_id, a, ctx.mcpReq.signal), true);
  tool('close_position', 'Submit a delegated close after fresh simulation. Reuse request_id and identical arguments on retries.',
    { ...close, request_id: requestId }, ({ request_id, ...a }, ctx) => service.write('close', request_id, a, ctx.mcpReq.signal), true);
  tool('create_market', 'Submit market creation using the operator wallet and separate creation cap. Requires prior collateral allowance; does not use the owner trading policy.',
    { ...create, request_id: requestId }, ({ request_id, ...a }, ctx) => service.write('create', request_id, a, ctx.mcpReq.signal), true);
  tool('get_transaction_status', 'Reconcile a recorded request against canonical receipts and the configured confirmation depth. Never broadcasts.', { request_id: requestId }, a => {
    if (!service.transactions) throw new ToolError('READ_ONLY', 'Transaction journal is available only in broadcast mode.');
    return service.transactions.status(a.request_id);
  });
  return server;
}
