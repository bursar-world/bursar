import { encodeFunctionData } from 'viem';
import { settlementAssetAbi } from '@bursar/core';
import { verifyBinding } from './binding.js';
import { assetDomain } from './domain.js';
import { issuerRefusal, isRevert, simulationRefusal } from './issuer.js';
import { refuse, type AuthorizationPath, type MethodContext, type MethodVerdict } from './method.js';
import { readPermit, readSignature, sameAddress } from './payload.js';
import { REASON } from './reasons.js';

/**
 * The EIP-2612 fallback: the payer signs an allowance, the relayer spends it.
 *
 * Two transactions, so it costs more gas than EIP-3009 and is slower by a block. It exists because
 * a token may implement `permit` and not `transferWithAuthorization`, and because a payer's wallet
 * may only know how to sign the one type. USDG answers both.
 *
 * It also asks for more trust. A permit authorises a spender for an amount and says nothing about
 * where the funds go. The payer is relying on the relayer to forward them to the payee named in
 * the requirements. EIP-3009 signs the recipient in and asks for none of that, which is why it is
 * the default.
 */
export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/**
 * What a binding signature covers on this path.
 *
 * An EIP-2612 nonce is a counter the token owns, so unlike the other two paths there is no field
 * the client may choose and the request digest cannot be folded into one. The permit is identified
 * instead by the token, the owner and that counter, which is unique for exactly one permit.
 */
export function permitPaymentRef(token: string, owner: string, nonce: bigint): string {
  return `${token.toLowerCase()}:${owner.toLowerCase()}:${nonce.toString()}`;
}

async function check(context: MethodContext): Promise<MethodVerdict> {
  const { chain, asset, payload } = context;

  const permit = readPermit(payload['permit']);
  const signature = readSignature(payload['signature']);
  if (permit === null || signature === null) return refuse(REASON.payload);

  const payer = permit.owner;

  if (context.relayer === null) {
    return refuse(REASON.method, payer, 'permit settlement needs a configured relayer');
  }
  if (!sameAddress(permit.spender, context.relayer)) return refuse(REASON.spender, payer);
  if (permit.value !== context.required) return refuse(REASON.value, payer);
  if (permit.deadline < BigInt(context.now + context.mustOutlive)) return refuse(REASON.expired, payer);

  if (context.binding !== null) {
    const bound = await verifyBinding({
      paymentRef: permitPaymentRef(asset.address, payer, permit.nonce),
      requestHash: context.binding.requestHash,
      signature: typeof payload['bindingSignature'] === 'string' ? payload['bindingSignature'] : '',
      payer,
    });
    if (!bound) return refuse(REASON.unbound, payer);
  }

  const valid = await chain.verifyTypedData({
    address: payer,
    domain: assetDomain(asset, chain.chainId),
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: {
      owner: permit.owner,
      spender: permit.spender,
      value: permit.value,
      nonce: permit.nonce,
      deadline: permit.deadline,
    },
    signature,
  });
  if (!valid) return refuse(REASON.signature, payer);

  const [balance, expectedNonce, controls] = await Promise.all([
    chain.balanceOf(asset.address, payer),
    chain.permitNonce(asset.address, payer),
    // The pull happens in a second transaction that no simulation here can cover, which makes the
    // issuer's answer worth more on this path than on any other: it is the only one read before
    // the relayer has already spent gas landing the permit.
    chain.issuerControls(asset.address, [payer, context.payTo]),
  ]);
  // The counter is strictly sequential, so a stale permit is a replay and a future one would sit
  // unusable. Either way it is refused here, before the relayer pays for a revert.
  if (permit.nonce !== expectedNonce) {
    return refuse(REASON.permitNonce, payer, `token expects nonce ${expectedNonce.toString()}`);
  }

  const issuer = issuerRefusal(asset, controls, { payer, payee: context.payTo });
  if (issuer !== null) return issuer;

  if (balance < permit.value) return refuse(REASON.funds, payer);

  const permitCall = {
    to: asset.address,
    data: encodeFunctionData({
      abi: settlementAssetAbi,
      functionName: 'permit',
      args: [permit.owner, permit.spender, permit.value, permit.deadline, signature],
    }),
  } as const;

  const pullCall = {
    to: asset.address,
    data: encodeFunctionData({
      abi: settlementAssetAbi,
      functionName: 'transferFrom',
      args: [permit.owner, context.payTo, permit.value],
    }),
  } as const;

  try {
    await chain.simulate(permitCall, context.relayer);
  } catch (error) {
    // As on the EIP-3009 path: a simulation that never reached the EVM is not a verdict on the
    // payment, so it propagates instead of becoming a refusal.
    if (!isRevert(error)) throw error;
    return simulationRefusal(error, asset, { payer, payee: context.payTo });
  }

  // The pull is not simulated. There is no allowance to pull against until the permit lands, so a
  // simulation from current state would report a revert that says nothing about this payment.
  return { ok: true, payer, amount: permit.value, calls: [permitCall, pullCall] };
}

export const eip2612Path: AuthorizationPath = { method: 'eip2612', check };
