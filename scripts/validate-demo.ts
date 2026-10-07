import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Whitelist read-only configuration. This script never forwards a signing key or --broadcast.
const env: Record<string, string> = {};
for (const name of ['PRIPO_MCP_RPC_URL', 'PRIPO_MCP_OWNER', 'PRIPO_MCP_INDEXER_URL']) {
  if (process.env[name]) env[name] = process.env[name]!;
}
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'], cwd: process.cwd(), env, stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', data => { stderr += String(data); });
const client = new Client({ name: 'pripo-demo-validation', version: '1' });
const market = '0xeA326A40694dA4D7C5c64719B48Ba561EcA8C0Eb';
const report: Record<string, unknown> = { validatedAt: new Date().toISOString(), chainId: 10143, market, writes: 0 };
async function call(name: string, args: Record<string, unknown> = {}, expectedError?: string): Promise<Record<string, any>> {
  const response = await client.callTool({ name, arguments: args });
  const data = response.structuredContent as { ok: boolean; result: Record<string, any>; error: { code: string } };
  if (expectedError) { assert.equal(response.isError, true); assert.equal(data.error.code, expectedError); return data.error; }
  assert.equal(data.ok, true, JSON.stringify(data)); return data.result;
}
try {
  await client.connect(transport);
  report.tools = (await client.listTools()).tools.map(t => t.name);
  report.protocol = await call('get_protocol'); assert.equal((report.protocol as { mode: string }).mode, 'read-only');
  report.markets = await call('list_markets');
  report.marketState = await call('get_market', { market });
  report.positions = await call('get_positions', { market });
  report.health = await call('get_health', { market });
  report.openQuote = await call('quote_open', { market, size: '100000000000000000' });
  report.closeQuote = await call('quote_close', { market, size_fraction: '100000000000000000' });
  report.rpcBook = await call('get_book', { market });
  report.writeRejection = await call('open_position', { market, size: '1', limit_price: '1', request_id: 'read-only-check' }, 'READ_ONLY');
  if (env.PRIPO_MCP_INDEXER_URL) {
    // The current bounded demo index is intentionally historical; reject the default age.
    report.staleIndexerRejection = await call('get_book', { market, source: 'indexer' }, 'STALE_INDEXER');
    report.historicalBook = await call('get_book', { market, source: 'indexer', max_age_seconds: 31_536_000 });
  }
  await writeFile(resolve('docs/demo-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, tools: (report.tools as string[]).length, writes: 0, report: 'docs/demo-validation.json' }));
} catch (error) {
  console.error('Read-only MCP validation failed.', stderr);
  throw error;
} finally { await client.close(); }
