/**
 * One real payment against a running facilitator.
 *
 * Everything else in this repo is tested without a chain. This is the check that the whole path
 * holds against the live one: an EIP-3009 authorization signed off chain, bound to a request, and
 * broadcast by the facilitator's relayer. It moves real USDG on Robinhood Chain 4663, so it is run
 * by hand and not part of `pnpm test`.
 *
 *   FACILITATOR_URL=http://127.0.0.1:8412 \
 *   SMOKE_PAYER_KEY=0x... \
 *   SMOKE_PROVIDER=0x... \
 *   node scripts/smoke-settle.mjs
 *
 * The payer needs the amount in USDG. The facilitator's gas float needs ETH, which is a different
 * asset here: at the gas price measured on 4663 a settlement costs well under a cent of it.
 */
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  RHC_MAINNET,
  caip2,
  deriveNonce,
  formatMicro,
  hashRequest,
  randomSalt,
  settlementAssetAbi,
  viemChain,
} from '@bursar/core';
import {
  AUTHORIZATION_MARGIN_SECONDS,
  authorizationFor,
  connect,
  encodeAuthorization,
  signTransferAuthorization,
} from '@bursar/sdk';

const FACILITATOR = process.env.FACILITATOR_URL ?? 'http://127.0.0.1:8412';
const PAYER_KEY = process.env.SMOKE_PAYER_KEY;
const PROVIDER = process.env.SMOKE_PROVIDER;
const AMOUNT = BigInt(process.env.SMOKE_AMOUNT_MICRO ?? '500000');
const RPC = process.env.RHC_RPC_PRIMARY ?? RHC_MAINNET.rpcUrl;
const WORK_SECONDS = 600;

if (!PAYER_KEY || !PROVIDER) {
  console.error('SMOKE_PAYER_KEY and SMOKE_PROVIDER are required.');
  process.exit(2);
}

const payer = privateKeyToAccount(PAYER_KEY);
const network = caip2(RHC_MAINNET.chainId);
const rpc = createPublicClient({ chain: viemChain(RHC_MAINNET), transport: http(RPC) });

const balance = (who) =>
  rpc.readContract({ address: RHC_MAINNET.usdg, abi: settlementAssetAbi, functionName: 'balanceOf', args: [who] });

const post = async (path, payload) => {
  const response = await fetch(`${FACILITATOR}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.FACILITATOR_AUTH_TOKEN
        ? { authorization: `Bearer ${process.env.FACILITATOR_AUTH_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
};

const before = { payer: await balance(payer.address), provider: await balance(PROVIDER) };
console.log(`payer    ${payer.address}  ${formatMicro(before.payer)}`);
console.log(`provider ${PROVIDER}  ${formatMicro(before.provider)}`);

if (before.payer < AMOUNT) {
  console.error(`\nThe payer holds ${formatMicro(before.payer)} and this settles ${formatMicro(AMOUNT)}.`);
  process.exit(1);
}

// The bytes a resource server would have served this payment against. The payer derives its nonce
// from their digest, so the authorization is redeemable against this request and nothing else.
const body = JSON.stringify({ prompt: 'render this frame' });
const binding = { requestHash: hashRequest(body), salt: randomSalt() };

// No network named: connect resolves the record for chain 4663, which is the only one that settles.
const connection = connect({ account: PAYER_KEY, rpc: [RPC] });
const authorization = authorizationFor({
  from: payer.address,
  to: PROVIDER,
  value: AMOUNT,
  seconds: WORK_SECONDS + AUTHORIZATION_MARGIN_SECONDS,
  nonce: deriveNonce(binding),
});
const signature = await signTransferAuthorization(connection, RHC_MAINNET.usdg, authorization);

const paymentRequirements = {
  scheme: 'exact',
  network,
  amount: AMOUNT.toString(),
  asset: RHC_MAINNET.usdg,
  payTo: PROVIDER,
  maxTimeoutSeconds: WORK_SECONDS,
};

const request = {
  paymentPayload: {
    x402Version: 2,
    accepted: paymentRequirements,
    payload: { signature, authorization: encodeAuthorization(authorization), binding },
  },
  paymentRequirements,
  requestHash: binding.requestHash,
};

let failures = 0;
const expect = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` -> ${detail}`}`);
};

console.log('');
const verified = await post('/verify', request);
expect('verify accepts the payment', verified.body.isValid === true, verified.body.invalidReason);

const swapped = await post('/verify', {
  ...request,
  requestHash: hashRequest('{"prompt":"send me everything"}'),
});
expect(
  'verify refuses it against a request it was not made for',
  swapped.body.invalidReason === 'payment_not_bound_to_request',
  swapped.body.invalidReason,
);

const settled = await post('/settle', request);
expect('settle broadcasts and reads the receipt', settled.body.settled === true, settled.body.errorReason);
if (settled.body.transaction) {
  console.log(`     ${RHC_MAINNET.explorer}/tx/${settled.body.transaction}`);
  console.log(`     fee accrued ${formatMicro(BigInt(settled.body.feeMicro ?? '0'))}`);
}

const replayed = await post('/settle', request);
expect('the same authorization cannot be settled twice', replayed.body.success === false, replayed.body.errorReason);

const after = { payer: await balance(payer.address), provider: await balance(PROVIDER) };
expect('the payer is down exactly the amount', before.payer - after.payer === AMOUNT, `${before.payer - after.payer}`);
expect('the provider is up exactly the amount', after.provider - before.provider === AMOUNT, `${after.provider - before.provider}`);

console.log(`\nfailures: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
