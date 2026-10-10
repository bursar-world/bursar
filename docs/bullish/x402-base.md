# x402 on Base, paid from a Bursar mandate

**The sentence:** a Bursar mandate pays any x402 service on Base in USDC, settled through Bursar's
facilitator.

The agent calls `mandate.fetch(url, { lane: 'base' })`. The mandate locks USDG on Robinhood Chain under
its own limits, Bursar's facilitator pays the service in USDC from a float it holds on Base, and the lock
settles to the facilitator once the USDC has moved. A payment the service never takes returns to the
mandate. The owner sees every call in Settlements, in USDG, with the limits, payee rules and capability
rules the mandate already has.

## Design

### Parties

| Party | Chain | Role |
|---|---|---|
| Agent, through the SDK | | Calls the service, opens the lock, carries the payment header. Holds the agent key and nothing else. |
| Mandate account | Robinhood Chain 4663 | `spend` checks every limit and moves USDG into an escrow lock payable to the facilitator's Base lane address. |
| Escrow | Robinhood Chain 4663 | Holds the lock. The payee releases it once the Base payment is confirmed, or cancels it to return the funds. |
| Bursar facilitator | both | Quotes, verifies the lock, signs the USDC authorization from its Base float, watches Base, settles or returns the lock. |
| The Base service and its facilitator | Base 8453 | Any x402 resource that accepts the `exact` scheme in USDC. Its own facilitator (Coinbase's, for most of the Bazaar) verifies the authorization and settles `transferWithAuthorization` on Base. |

One key serves the lane on both chains. On Base its address holds the USDC float and signs the
authorizations. On Robinhood Chain the same address is the payee of every lock the lane opens, which is
what lets it release and cancel them, and it is where the released USDG lands. The operator sweeps that
USDG and refills USDC on Base; the lane keeps the two sides in one ledger so the gap is always visible.

### Message flow

1. The SDK sends the request. The service answers 402 with its offers. The SDK takes the cheapest
   `exact` offer in USDC on `eip155:8453` that fits `maxAmount`, if one was given.
2. The SDK asks the facilitator for a quote: `POST /base/quote { amount, payTo, resource }`. The
   facilitator answers the lock it needs: payee (the Base lane address), amount in USDG, the fee, and
   how long the authorization will be valid. A float that cannot cover the amount on top of what it has
   already promised refuses here, before anything is locked.
3. The SDK asks the mandate whether it would pay that lock (`assertCanPay`), then opens it with the
   mandate's own `spend`. The lock's published input is the request document the mandate lane already
   uses: method, resource and the request-bound nonce derived from the body digest and a salt the payer
   keeps. The owner sees the lock in Settlements the moment it lands.
4. The SDK sends the lock and the service's offer to the facilitator: `POST /base/pay { lock, binding,
   offer }`. The facilitator reads the lock on chain (open, opened by a mandate account from a known
   factory, payable to the lane address, for the quoted amount, bound to this request, with enough
   deadline left), records it in the lane ledger under the lock's identity so one lock yields one
   authorization, and signs an EIP-3009 `TransferWithAuthorization` from the float: to the service's
   `payTo`, for the USDC amount, nonce derived from the same binding, valid until the offer's timeout
   plus a margin. The signature travels back to the SDK.
5. The SDK retries the request with the payment header. The service's facilitator settles the
   authorization on Base: USDC moves from the float to the service. The service answers 200 and the
   settlement header, or refuses.
6. The SDK reports what it saw to the facilitator (`POST /base/payments/{id}/outcome`). The report is
   a hint, never the record.
7. The facilitator's lane worker runs with the maintenance pass. For every signed authorization it asks
   USDC on Base whether the nonce has been used. Used: it finds the Base transaction and releases the
   lock on Robinhood Chain, with the Base transaction hash as the output commitment. Unused and past
   its validity: it cancels the lock, which returns the USDG to the mandate and credits the windows
   through the escrow's callback. Either way the row closes with both hashes.

Why the facilitator never proxies the call: the agent keeps its request and the service's response to
itself, and the facilitator's exposure is exactly one authorization per lock, bounded by the lock. Why
the chain and not the SDK's report decides settlement: the authorization state on USDC is the one fact
neither party can fake.

### Where each failure is handled

| Failure | Where | What happens |
|---|---|---|
| The service offers nothing in USDC on Base | SDK | `NoAcceptablePaymentError`, nothing locked. |
| The float is short, the lane is off, the amount is over the per-payment ceiling | facilitator, at quote | A refusal in the SDK's words (`BaseLaneRefusedError`), nothing locked. |
| The mandate refuses (cap, window, merchant, capability, paused) | mandate, before `spend` | The mandate's own refusal, nothing locked. |
| The lock is not what was quoted, is not bound to the request, or was already paid | facilitator, at pay | Refused, nothing signed. The lock is the mandate's to reclaim with `timeout` after its deadline, or the facilitator cancels it on the next pass if it is payable to the lane. |
| The service refuses the payment or never settles | service | The authorization expires unused. The worker cancels the lock and the mandate's windows are credited back. The SDK throws `PaymentRejectedError` naming the lock and when it returns. |
| USDC moved and the service answered an error | service | The facilitator still releases the lock: the service was paid. The dispute is between the agent and the service, outside Bursar's rails. The SDK surfaces the response as is. |
| Base cannot be read | facilitator worker | The row stays open and is retried next pass. The lock's deadline bounds how long: past it the escrow returns the funds to the mandate on `timeout`. |
| The release or cancel on Robinhood Chain fails | facilitator worker | Retried every pass until the deadline. A row still open at the deadline is counted as stuck in health. |
| The facilitator is down | | No authorization is ever signed, so no USDC moves. A lock opened just before stays reclaimable by the mandate on `timeout`. |

### The float

- `bursar_base_payments` is the per-payment ledger: one row per lock, keyed on the lock's identity
  (chain, escrow, lock id). States: `signed` (an authorization is out and USDC may move until it
  expires), `paid` (USDC moved, release pending), `settled` (lock released), `returned` (authorization
  expired unused, lock cancelled).
- Promised = the USDC sum of `signed` rows. Available = the float's USDC balance less promised. A quote
  or a pay that would leave available under `FACILITATOR_BASE_FLOAT_MINIMUM_MICRO` is refused as
  `base_float_insufficient`.
- `FACILITATOR_BASE_MAX_PAYMENT_MICRO` caps one authorization. Health reports the float address, its
  balance, what is promised, what is available and the count of rows past their deadline.
- The float needs USDC on Base and nothing else there: the service's facilitator pays the gas to settle
  an EIP-3009 authorization. On Robinhood Chain the same address needs a little ETH for release and
  cancel transactions, a registry stake so the escrow admits it as a payee, and a place on each
  mandate's merchant list.

### The fee

One USDG buys one USDC. The lock is the USDC amount plus a fee: the larger of
`FACILITATOR_BASE_FEE_BPS` of the amount and `FACILITATOR_BASE_FEE_FLOOR_MICRO`, and never less than the
escrow's smallest lock (one cent on the live escrow). The quote states the fee as the difference between
the lock and the amount, so a 0.1 cent call shows a one cent lock with a 0.9 cent fee. The escrow takes
its own 1% from the payee's side when the lock releases, out of the facilitator's share.

### Refusals, in the SDK's words

`BaseLaneRefusedError` carries the facilitator's reason and a sentence that names the condition, whose
it is and what to do: `base_lane_off`, `base_float_insufficient`, `base_amount_too_large`,
`base_offer_unsupported`, `base_lock_not_open`, `base_lock_payee_mismatch`, `base_lock_amount_mismatch`,
`base_lock_not_bound`, `base_lock_deadline_too_close`, `base_lock_already_paid`,
`base_payer_not_a_mandate`, `base_lock_unreadable`.

## Progress

- 15:30 UTC: rules, repository, facilitator, SDK and escrow read; Base balances of every Bursar key
  checked (none hold USDC on Base); example mandate state read (agent is the payer key, `payee` is an
  allowed merchant, registered and active); candidate services on the Bazaar read (402rates, Useless
  Facts, Otto, all 0.001 USDC on `eip155:8453` with the USD Coin v2 domain). Design written.
- 17:50 UTC: core carries the Base constants; the facilitator has the lane (`services/facilitator/src/base/`),
  its migration, five public routes, health and the worker on the maintenance pass; the SDK has
  `lane: 'base'` with the refusal sentences. Unit tests with Base mocked at the chain port and the
  ledger against Postgres are green in both packages. Next: the demo against a live service, the fork
  rig for the happy path, screenshots, the recording.
