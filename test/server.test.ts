import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { PripoClient } from '@pripo/sdk';
import { createServer } from '../src/server.js';
import { PripoService } from '../src/service.js';
import { config } from './helpers.js';

test('MCP transport exposes strict tools, lossless results and read-only errors without credentials', async () => {
  let quoteCalls = 0;
  const service = new PripoService({ ...config, broadcast: false }, {} as PripoClient);
  service.quoteOpen = async () => { quoteCalls++; return { precise: 100050025012506253127n } as never; };
  service.market = async () => { throw new Error('https://SECRET@provider.invalid/SECRET'); };
  const server = createServer(service); const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const { tools } = await client.listTools(); assert.equal(tools.length, 16);
    assert.equal(tools.find(t => t.name === 'open_position')!.annotations!.readOnlyHint, false);
    assert.equal(tools.find(t => t.name === 'quote_open')!.annotations!.readOnlyHint, true);
    assert.ok(!tools.some(t => t.name === 'propose_settlement'));
    const quote = await client.callTool({ name: 'quote_open', arguments: { market: config.factory, size: '1000000000000000000' } });
    assert.deepEqual(quote.structuredContent, { ok: true, result: { precise: '100050025012506253127' } });
    for (const args of [{ market: config.factory, size: 1e18 }, { market: config.factory, size: '1.1' },
      { market: config.factory, size: '1', unexpected: true }, { market: 'invalid', size: '1' }]) {
      const result = await client.callTool({ name: 'quote_open', arguments: args }); assert.equal(result.isError, true);
    }
    assert.equal(quoteCalls, 1);
    const readonly = await client.callTool({ name: 'open_position', arguments: {
      market: config.factory, size: '1', limit_price: '1', request_id: 'test-intent' } });
    assert.equal(readonly.isError, true); assert.equal((readonly.structuredContent as { error: { code: string } }).error.code, 'READ_ONLY');
    const error = await client.callTool({ name: 'get_market', arguments: { market: config.factory } });
    assert.equal(error.isError, true); assert.ok(!JSON.stringify(error).includes('SECRET'));
  } finally { await client.close(); await server.close(); }
});
