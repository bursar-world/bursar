# @bursar/circuits

The proving artifacts behind Bursar's private payments. `@bursar/sdk` and `@bursar/mcp` load them; an
agent does not install this package on its own.

Two circuits ship here:

- **Within mandate** (`build/`): proves a payment fits a private mandate's sealed terms, the limits,
  the kinds of work and the providers, without revealing them. The account checks the proof on every
  payment.
- **Shielded pool** (`privacy-pools/`): the deposit commitment and the withdrawal proof for the
  shielded USDG pool, vendored from Privacy Pools.

Each ships its compiled circuit, its proving key and its verification key, so a proof is made locally
with nothing fetched at runtime. The verification keys match the verifier contracts deployed on
Robinhood Chain.

```ts
import { artifacts } from '@bursar/circuits/artifacts';
import { shieldedArtifacts } from '@bursar/circuits/privacy-pools';
```

Node 22 or newer. ESM only.
