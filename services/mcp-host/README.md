# @bursar/mcp-host

The hosted form of `@bursar/mcp`: the same tools, reached over Streamable HTTP with a bearer token,
for assistants that cannot run a local process. ChatGPT, Claude and Gemini CLI each take a remote
MCP server; this service is one.

One token is one connection: one mandate, one agent key the host generated for it. The owner opens
a connection from the mandate's page in the console by signing a message, seats the agent the host
made, and pastes the token into the assistant. From then on the assistant's calls run against that
mandate and nothing else. The mandate account on chain enforces the limits, as it does for any
agent; this service cannot relax them.

## Routes

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /mcp` | the assistant, with `Authorization: Bearer <token>` | The MCP endpoint. `GET` and `DELETE` are accepted as the transport defines them. |
| `POST /mcp/<token>` | an assistant whose connector form takes a URL and no header | The same endpoint with the token in the path. |
| `POST /connections` | the console, on the owner's behalf | Opens a connection. The body is the signed message's fields and the signature; the host recovers the signer and checks it against the mandate's principal on chain. Answers the agent address, the token (once) and the connector settings. |
| `GET /connections?mandate=0x…` | the console | The connections on a mandate. Never a token. |
| `POST /connections/<id>/revoke` | the console, on the owner's behalf | Cuts a connection. Signed the same way. The token stops answering at once. |
| `GET /healthz`, `GET /readyz` | the platform | Liveness, and readiness with the database and pending migrations. |

A token is 32 random bytes, shown once; the store keeps its SHA-256. Agent keys are sealed with
AES-256-GCM under `MCP_HOST_KEK`, with the chain, mandate and agent address bound in as associated
data, and are opened only in the memory of the process that is about to sign. Nothing this service
logs carries a token or a key.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres. TLS follows `sslmode` in the URL. |
| `MCP_HOST_KEK` | yes | 32 bytes of hex. Seals every agent key at rest. Keep it where you keep a signing key; without it no connection can be read or made. |
| `MCP_HOST_HOST`, `MCP_HOST_PORT` | no | The listener. Defaults to `127.0.0.1:8410`. |
| `MCP_HOST_PUBLIC_URL` | in a deployment | The address connectors are given, such as `https://mcp.bursar.world`. |
| `MCP_HOST_MIGRATE` | no | `on-start` (default), `verify` or `off`. |
| `MCP_HOST_TOKEN_RPM` | no | Requests one token may make a minute. Defaults to 120. |
| `MCP_HOST_CONNECTIONS_PER_HOUR` | no | Connections one owner may open an hour. Defaults to 20. |
| `MCP_HOST_PROOF_WINDOW_SECONDS` | no | How long an owner's signature stays usable. Defaults to 600. |
| `RHC_RPC_PRIMARY`, `RHC_RPC_FALLBACK` | yes, no | The endpoints, as every Bursar service reads them. |
| `BLOCKSCOUT_API_KEY` | for `mandate_list_settlements` | The index key the tools read history with. |

Every other variable `@bursar/mcp` reads (`BURSAR_RECORD`, the chain overrides) is passed through
to each connection's tool set. The ones that name a role, a signer or a key file are not: a key
arriving from the environment is refused at startup, and `BURSAR_RELAY_URL` with it.

## Running it

```
pnpm --filter @bursar/mcp-host... build
cp services/mcp-host/.env.example services/mcp-host/.env   # fill it in
node services/mcp-host/dist/main.js
```

Tests: `pnpm --filter @bursar/mcp-host test`. The store's SQL runs against a real server when
`BURSAR_TEST_DATABASE_URL` points at one; the suite makes its own database there and drops it.

`scripts/demo.ts` is the owner's side of the demo from a terminal: it creates a mandate from a
keystore, allows a provider and a capability, funds it, opens a connection on a running host, seats
the agent and gives it ETH for fees. Its header has the command.
