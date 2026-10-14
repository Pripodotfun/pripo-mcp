#!/usr/bin/env node
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { json, publicError, ToolError } from './errors.js';
import { createPrivyServerWallet } from './privy.js';
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
  if (process.argv[2] === 'privy-wallet') {
    // Creates a Privy server wallet for use as an operator. Prints only its ID and public address.
    if (process.argv.length !== 3 || !process.env.PRIVY_APP_ID || !process.env.PRIVY_APP_SECRET)
      throw new ToolError('CONFIGURATION', 'Usage: PRIVY_APP_ID=… PRIVY_APP_SECRET=… pripo-mcp privy-wallet');
    const wallet = await createPrivyServerWallet({ appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET });
    console.log(JSON.stringify({ PRIPO_MCP_PRIVY_WALLET_ID: wallet.id, PRIPO_MCP_OPERATOR_ADDRESS: wallet.address }, null, 2));
    process.exit(0);
  }
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
