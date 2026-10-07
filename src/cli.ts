#!/usr/bin/env node
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { json, publicError } from './errors.js';
import { PripoService } from './service.js';
import { FileStore } from './store.js';
import { Transactions } from './transactions.js';
import { createServer } from './server.js';

let store: FileStore | undefined;
let transactions: Transactions | undefined;
let handle: StdioServerHandle | undefined;
let stopping: Promise<void> | undefined;
function stop() {
  return stopping ??= (async () => {
    await handle?.close();
    await transactions?.idle();
    await store?.close();
    process.stdin.pause();
  })();
}
const report = (error: unknown) => console.error(JSON.stringify(json(publicError(error))));
try {
  const { config, chain, account } = await loadConfig(process.argv.slice(2));
  let service = PripoService.connect(config, chain);
  await service.verifyDeployment();
  if (account) {
    const identity = [config.chainId, config.factory, config.vault, config.owner, account.address].join(':').toLowerCase();
    store = await FileStore.open(config.statePath, identity);
    transactions = new Transactions(service.sdk.publicClient, config, store, account);
    await transactions.initialize();
    service = new PripoService(config, service.sdk, transactions);
  }
  handle = serveStdio(() => createServer(service), { onerror: report });
  const shutdown = () => { void stop().catch(error => { report(error); process.exitCode = 1; }); };
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  report(error); process.exitCode = 1;
  await stop();
}
