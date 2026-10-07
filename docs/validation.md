# Validation

Validated locally on 2026-10-07:

- `npm run check`: vendored SDK provenance, TypeScript, 16 automated tests, and production build pass.
- Real stdio MCP integration on Node 22.22 with isolated Anvil and source checked against contracts commit `7c868c5c1ae34f6b00c204bdf1cdf3c6608148bf`: pass.
- Read-only stdio MCP against the configured Monad testnet factory/vault and `PRIPO:DEMO`: pass. Exact public results and block provenance are recorded in `demo-validation.json`.

The contract integration deploys the vault proxy, linked market implementation, factory, mock collateral and NullAdapter. It opens and closes for a separate owner through the operator key. Exact contract policy errors cover per-transaction notional (4), cumulative notional (5), invalid market proof (3), forbidden close and revocation. It verifies retries before and after an MCP process restart keep the same hash and consume no additional nonce. It creates a second market funded by the operator, rejects a seed bond above the cap, and checks the creator address.

Automated tests separately cover concurrent duplicate IDs, lost RPC submission responses, reuse after restart, changed-argument rejection, canonical receipt/confirmation depth, reorg downgrade, corrupt journal signatures, exclusive locking, file permissions, persistence failure, chain/signer/gas/value/fee/balance/nonce checks, cancellation, malformed amounts, strict tool schemas, read-only writes, provider-error redaction and indexer provenance/age validation.

The testnet validation forwarded only RPC, public owner address and indexer URL to the MCP process. No private key was loaded and no onchain write was made. It read live market/position/health/book data, requested open/close quotes, verified that a write tool returns `READ_ONLY`, rejected the bounded indexer's old book at the default 60-second age, and retrieved it with an explicit historical age allowance after checking its canonical block.

Subsequent [local client setup](local-client.md) funded a dedicated testnet operator and granted a demo-market-only policy. The broadcast-capable MCP server then passed unsigned delegated open/close simulations and invalid-proof rejection. Codex itself discovered all 16 tools. These later checks sent no position trades; the owner-signed funding and policy receipts are recorded separately in `operator-setup.json`.

Not yet validated here: Pyth-fed MCP trading against a live oracle, testnet operator broadcasting, hosted multi-user transport, load/soak behavior, or production signer recovery after filesystem loss. Pyth preparation is delegated to the existing pinned SDK; the local MCP contract test uses NullAdapter. The recorded indexer data is a bounded historical demo, not a running continuous index.
