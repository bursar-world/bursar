# @bursar/asp

The association-set provider for Bursar's shielded USDG pool on Robinhood Chain. A withdrawal from
the pool must prove that its deposit's label is in the latest association set; this service
decides that set, posts its root to the Entrypoint and serves the set so wallets can prove against
it.

## The rule

Every deposit into the pool is admitted unless the Robinhood access registry
(`0xe10b6f6B275de231345c20D14Ab812db62151b00`) reports its depositor as blocked. Labels keep
deposit order. The registry is read again on every cycle, so a depositor blocked after depositing
drops out of the next set. A deposit outside the set can still leave through ragequit, publicly,
to the wallet that made it; the pool itself refuses to pay a blocked address either way.

The set is a pure function of the pool's events and the registry
(`buildAssociationSet` in `@bursar/sdk`), so anyone can recompute it: `bursar-asp verify`.

Each post stores the root and the CIDv1 (raw, sha2-256) of the set document's canonical JSON. The
document is served at `/v1/association-set/<cid>` and can be pinned to IPFS unchanged.

## Posting cadence

The pool takes withdrawal proofs against the newest root only, so every post turns away the proofs
made against the one before it. The service therefore posts at most once every ten minutes,
counted from the last root on chain, and the deposits that land inside one window go out together
in the next post. A wallet whose proof meets a newer root proves again against it; the SDK's
`relayWithFreshProof` does that for the console.

## Use

```sh
pnpm --filter @bursar/asp build
bursar-asp post --dry-run    # print the set, send nothing
bursar-asp post              # post the root if it changed and the window is open
bursar-asp run               # serve on PORT (4320), recompute every ASP_INTERVAL_SECONDS (30), post on the cadence
bursar-asp verify            # recompute and compare with the posted root
```

The postman key is `ASP_PRIVATE_KEY`, or `ASP_KEYSTORE` with `ASP_PASSWORD_FILE`. It must hold
`ASP_POSTMAN` on the Entrypoint. `ASP_DATA_DIR` keeps published sets across restarts.

HTTP: `GET /v1/association-set` (the set whose root the chain holds), `GET
/v1/association-set/<cid>`, `GET /health`.
