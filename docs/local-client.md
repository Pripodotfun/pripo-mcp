# Local Codex connection and testnet operator

Configured on 2026-10-07. The global Codex MCP entry is named `pripo` and launches the compiled stdio server with Node 22.22, an absolute `.env` path and `--broadcast`. The key remains in the ignored, mode-0600 local `.env`; it is not embedded in the Codex configuration or these reports. The journal path is absolute so changing the client's working directory does not create a second journal.

Start a new Codex session (or restart the IDE extension) to load the new server. `codex mcp get pripo --json` shows the configured command. MCP tools will be available under the `pripo` server. A first request can be: “Use Pripo to show my operator policy and demo-market position.”

The server configuration uses the standard [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). There is no OAuth login for this local stdio server. Run only one broadcast server with this operator/journal at a time; additional sessions fail closed on the journal lock. Close the existing MCP session before running the standalone verification command.

| Setting | Value |
| --- | --- |
| Network | Monad testnet, chain 10143 |
| Owner | `0x3b2F1773a1B279A1b0b13aD425019C91433693c3` |
| Dedicated operator | `0xF996d91542dBa81193154b14bec45AB0c10ae9C0` |
| Allowed market | `0xeA326A40694dA4D7C5c64719B48Ba561EcA8C0Eb` (`PRIPO:DEMO`) |
| Per-transaction notional | 150 mock mUSDC |
| Cumulative notional | 500 mock mUSDC, including closes |
| Close permission | Enabled |
| Expiry | Block `69164908` (100,000 blocks after preparation) |
| Gas funding | 0.1 testnet MON |
| Creation | Disabled |

This is a single-leaf market allowlist. Use `market_proof: []` for the demo market; a different market or extra proof does not match the root. No policy is renewed automatically. After expiry or exhaustion, the owner must explicitly grant a new policy; changing a policy resets its cumulative usage.

Confirmed setup transactions:

- [Fund operator gas](https://testnet.monadvision.com/tx/0xd7672b92344acd68152dc8b7820680c3e2d5c851569d2d459da5f8c9b6433926)
- [Grant operator policy](https://testnet.monadvision.com/tx/0x7e40b5dbbc100394b8aec8752d7b1b802723e649c40e0d1cb5595b2422fb6665)

`operator-setup.json` records canonical receipts and policy reads. `operator-verification.json` records an MCP handshake, all 16 discovered tools, successful delegated open/close simulations, invalid-proof rejection, and unchanged position state. Only gas funding and policy setup were broadcast; no position was opened or closed.

The installed Codex CLI 0.157.1 app-server also loaded `pripo` and discovered all 16 tools through `mcpServerStatus/list`. That check started no model turn and submitted no transactions; its result is saved in `codex-connection.json`.

## Repeat verification

From this repository, with the configured MCP session closed:

```sh
node --env-file=.env --import tsx scripts/verify-operator.ts
```

This launches the broadcast-capable server but only calls a fixed allowlist of read and prepare tools. It does not call mutating tools. It assumes the demo owner's existing long position is still open and the policy remains active. A successful preview does not reserve its price; request a fresh preview before an intentional trade.

## Provisioning recovery

The one-time setup was prepared using `scripts/provision-operator.ts --prepare`. It is restricted to this testnet owner, vault and market. The fixed plan lives in `.state/operator-plan.json`, with signed setup transactions in `.state/operator-provisioning.json`. Both are ignored by Git.

Only the explicit `--broadcast` mode reads the owner key, from the file named by `PRIPO_OWNER_ENV_FILE` and its `FUNDED_DEPLOYER_PRIVATE_KEY` entry. The MCP server itself never loads that owner file. If the setup command is interrupted, retry with the original plan and journal:

```sh
PRIPO_OWNER_ENV_FILE=../pripo-contract/.env \
  node --env-file=.env --import tsx scripts/provision-operator.ts --broadcast
```

Retries reuse recorded transaction IDs and signed bytes. They do not top up gas again or reset an already confirmed policy. This command is not a renewal or refueling workflow. Retain the plan and journal, even after completion. The owner can revoke the operator through `MarginVault.revokeOperator(operator)` independently of MCP.
