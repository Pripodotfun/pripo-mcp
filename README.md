# Pripo MCP

A standalone local stdio MCP server for Pripo on Monad. It wraps the pinned `@pripo/sdk` with block-stamped reads, unsigned transaction previews, delegated operator trading, and a durable transaction journal. The default mode is read-only.

This repository is independent of the contracts, SDK, keeper and indexer repositories. The vendored SDK archive and its provenance are checked by `npm run check`; no sibling checkout is needed to build or run it.

## Run locally

Use Node 22.22 (see `.nvmrc`) or a newer supported LTS release. Node 22.15+ is required.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
cp .env.example .env
chmod 600 .env
# Set PRIPO_MCP_RPC_URL in .env.
node --env-file=.env dist/cli.js
```

The server speaks JSON-RPC on stdout; it waits silently for an MCP client. Diagnostics go to stderr with provider credentials removed. Use a reliable RPC with historical state access for indexed-book canonical-block checks. The bundled deployment uses testnet mock mUSDC with six decimals; it is not Circle USDC.

For an MCP host that accepts `mcpServers`, use absolute paths and a Node binary available to the host:

```json
{
  "mcpServers": {
    "pripo": {
      "command": "/absolute/path/to/node",
      "args": [
        "--env-file=/absolute/path/to/pripo-mcp/.env",
        "/absolute/path/to/pripo-mcp/dist/cli.js"
      ]
    }
  }
}
```

Do not launch through `npm start` from an MCP host: npm can print extra text on stdout. The server uses the official SDK's [`serveStdio`](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio) entry point for modern and legacy MCP clients.

The configured local Codex connection, testnet operator policy and setup receipts are documented in [local client setup](docs/local-client.md).

## Tools

All amounts are **decimal integer strings**, never JavaScript numbers. Prices, signed position sizes, collateral balances and fractions use WAD (18 decimals). Seed bonds use raw six-decimal token units. Pagination counts and age limits are small JSON numbers. Tool results contain `{ "ok": true, "result": ... }` in both text and `structuredContent`; operational errors contain `{ "ok": false, "error": { "code", "message", "details" } }` and `isError: true`.

| Tool | Inputs and behavior |
| --- | --- |
| `get_protocol` | Deployment, mode, fixed owner/operator and capabilities. |
| `list_markets` | `offset` string, `limit` number (1–50); returns `nextOffset`. |
| `get_market` | `market`; configuration, prices, OI, funding and vault ledger. |
| `get_book` | `market`, `source` (`rpc` by default or `indexer`), `max_age_seconds` (60 by default). |
| `get_positions` | Optional `user`, `market`, `offset`, `limit`; pages over markets, including empty ones. |
| `get_health` | `market`, optional `user`; ratio, liquidation reference/reason, position and pending ADL. |
| `quote_open` | `market`, signed `size`, optional `user`. Indicative quote at a fresh RPC block. |
| `quote_close` | `market`, `size_fraction` in `(0, 1e18]`, optional `user`. |
| `get_operator_policy` | Configured owner's operator policy, usage and block expiry. |
| `prepare_open` | `market`, `size`, `limit_price`, optional `market_proof` array of bytes32; simulates without signing. |
| `prepare_close` | `market`, `size_fraction`, `limit_price`, optional `market_proof`; simulates without signing. |
| `prepare_create_market` | `symbol`, `price_source`, `feed_id`, `initial_price`, `depth`, `seed_bond_usdc`; requires creation opt-in. |
| `open_position` | Same as `prepare_open`, plus `request_id`; broadcasts only with `--broadcast`. |
| `close_position` | Same as `prepare_close`, plus `request_id`. |
| `create_market` | Same as `prepare_create_market`, plus `request_id`. |
| `get_transaction_status` | `request_id`; canonical receipt and confirmation status from the local journal. Never broadcasts. |

Read addresses default to `PRIPO_MCP_OWNER` where applicable. Writes always use the configured owner and operator; callers cannot override them. Input schemas reject unknown fields, floating point amounts and integers outside contract bounds. Buy limits are maximum prices; sell limits are minimum prices.

`healthWad` is equity divided by entry notional, **not** equity divided by maintenance margin. A zero liquidation price must be interpreted with its reference kind and reason. RPC reads include chain ID, block number, hash and timestamp and are checked for a changed block during the read. Quotes are indicative; `prepare_*` and submission simulate current state with the SDK. External Pyth opens fetch updates; closes require no oracle payload or native update fee.

Indexed books preserve exact accounting integers. They represent the end of the last indexed event block, which can be old even when the indexer process is healthy. Age, chain/market identity and canonical hash are checked. RPC books return `positions`; indexer results retain the indexer's `book` snapshot and provenance. Historical snapshots never authorize or price a trade.

## Enable delegated trading

1. The owner deposits collateral and grants a dedicated operator a vault policy outside MCP. Set expiry, per-transaction and cumulative notional limits, optional market allowlist, and `canClose`. Revocation remains an owner action.
2. Fund the operator with a limited native-token gas balance. Use a signer dedicated to this server; do not submit its transactions from another wallet or process.
3. Set `PRIPO_MCP_OWNER` and `PRIPO_MCP_OPERATOR_PRIVATE_KEY` locally. To preview without a key, set only `PRIPO_MCP_OPERATOR_ADDRESS`. Read-only mode ignores any private key present in the environment.
4. Set `PRIPO_MCP_STATE_PATH` to an absolute path on persistent local storage, then add `--broadcast` to the CLI arguments. Keep one journal per deployment, owner and signer. The journal uses an exclusive lock and mode 0600.

The owner and operator must differ. Policy checks reject expired/revoked policies and forbidden closes before preparation; exact notional and Merkle proof checks run through contract simulation. Onchain checks remain authoritative if state changes between simulation and mining. Clean `POLICY_VIOLATION` errors include the contract reason when available.

Example delegated open, after explicit trading setup:

```json
{
  "market": "0xeA326A40694dA4D7C5c64719B48Ba561EcA8C0Eb",
  "size": "100000000000000000",
  "limit_price": "101000000000000000000",
  "market_proof": [],
  "request_id": "demo-open-001"
}
```

Choose a new `request_id` for each intentional trade. After a timeout, reuse the **same ID and identical arguments**. Signed bytes are persisted before broadcast; retries resend those bytes without allocating a new nonce. Different arguments with an existing ID are rejected. `pending` and `submission_unknown` are unresolved states, not failures; query `get_transaction_status` and wait for confirmation. New intents are blocked while an earlier transaction is unresolved.

Cancellation before signing prevents submission. Once an intent is signed and persisted, it may still be submitted even if the client disconnects; recover using its ID. A reverted transaction keeps its ID permanently. A later deliberate trade needs a new ID. No automatic fee replacement or transaction cancellation is implemented.

Market creation has a separate authorization model: the **operator** pays the seed bond and owns the created market. The owner's vault trading policy does not cover creation. It is disabled until `maxCreationSeedBondUsdc` in the deployment JSON is explicitly set above zero. This is a per-creation cap, not a lifetime budget; operator token balance and allowance should reflect the intended total budget. Token approvals are performed outside MCP. `--config /path/deployment.json` selects a custom deployment and transaction limits.

## Validate

```sh
npm run check
# Optional real-contract end-to-end test; needs Foundry and a matching contracts checkout.
PRIPO_CONTRACTS=../pripo-contract npm run test:integration
# Read-only demo check; .env must point to Monad testnet and the existing local book API.
node --env-file=.env --import tsx scripts/validate-demo.ts
```

The local integration test starts an isolated Anvil node and uses its public test mnemonic only. It verifies the contract source matches the ABI pin, builds artifacts, deploys contracts, and exercises the compiled CLI through a real MCP client. It covers delegated open/close, per-trade/cumulative limits, close permissions, allowlist proof rejection, revocation, retry/restart behavior and capped operator-funded creation.

[Validation notes](docs/validation.md) and [recorded demo results](docs/demo-validation.json) describe what has been exercised. [Operations notes](docs/operations.md) cover journal recovery and limits.

## Remaining work

This milestone provides local stdio access. Hosted HTTP authentication, x402 metering, a reference trading agent and live Pyth-market MCP validation are separate follow-ups. `propose_settlement` is unavailable because the pinned contracts/SDK do not implement a Resolver; `get_protocol` reports `settlementSupported: false`. Initial MCP validation was read-only; subsequent local-client setup funded a dedicated testnet operator and granted its restricted policy. No testnet position trades have been sent through MCP.
