import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Launch the same broadcast-capable server configured in the MCP host, but call
// only read/prepare tools. This script cannot submit a position transaction.
const transport = new StdioClientTransport({ command: process.execPath,
  args: [`--env-file=${resolve('.env')}`, resolve('dist/cli.js'), '--broadcast'],
  cwd: process.cwd(), stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', data => { stderr += String(data); });
const client = new Client({ name: 'pripo-operator-verification', version: '1' });
const market = '0xeA326A40694dA4D7C5c64719B48Ba561EcA8C0Eb';
const setup = JSON.parse(await readFile('docs/operator-setup.json', 'utf8'));
const report: Record<string, unknown> = { verifiedAt: new Date().toISOString(), positionTradesSent: 0, market };
async function call(name: string, args: Record<string, unknown> = {}, expectedError?: string): Promise<Record<string, any>> {
  assert.ok(['get_protocol', 'get_operator_policy', 'get_positions', 'quote_open', 'quote_close', 'prepare_open', 'prepare_close'].includes(name));
  const response = await client.callTool({ name, arguments: args });
  const data = response.structuredContent as { ok: boolean; result: Record<string, any>; error: { code: string } };
  if (expectedError) { assert.equal(response.isError, true); assert.equal(data.error.code, expectedError); return data.error; }
  assert.equal(data.ok, true, JSON.stringify(data)); return data.result;
}
try {
  await client.connect(transport);
  report.tools = (await client.listTools()).tools.map(t => t.name);
  report.protocol = await call('get_protocol');
  assert.equal((report.protocol as Record<string, unknown>).mode, 'broadcast');
  assert.equal((report.protocol as Record<string, unknown>).operator, setup.plan.operator);
  report.policy = await call('get_operator_policy');
  assert.equal((report.policy as Record<string, any>).expired, false);
  assert.equal((report.policy as Record<string, any>).policy.marketsRoot, setup.plan.marketsRoot);
  report.positionsBefore = await call('get_positions', { market });
  const openQuote = await call('quote_open', { market, size: '100000000000000000' });
  const closeQuote = await call('quote_close', { market, size_fraction: '100000000000000000' });
  report.openQuote = openQuote; report.closeQuote = closeQuote;
  // The demo has a long position; use a 1% price buffer for simulation only.
  const openInput = { market, size: '100000000000000000', limit_price: (BigInt(openQuote.avgFill) * 101n / 100n).toString(), market_proof: [] };
  const closeInput = { market, size_fraction: '100000000000000000', limit_price: (BigInt(closeQuote.avgFill) * 99n / 100n).toString(), market_proof: [] };
  report.preparedOpen = await call('prepare_open', openInput);
  report.preparedClose = await call('prepare_close', closeInput);
  report.badProofRejection = await call('prepare_open', { ...openInput, market_proof: [`0x${'11'.repeat(32)}`] }, 'POLICY_VIOLATION');
  report.positionsAfter = await call('get_positions', { market });
  assert.deepEqual((report.positionsBefore as Record<string, unknown>).positions, (report.positionsAfter as Record<string, unknown>).positions);
  await writeFile('docs/operator-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, tools: (report.tools as string[]).length, positionTradesSent: 0, report: 'docs/operator-verification.json' }));
} catch (error) {
  console.error('Operator verification failed.', stderr);
  if (error instanceof assert.AssertionError) console.error(error.message);
  process.exitCode = 1;
} finally { await client.close(); }
