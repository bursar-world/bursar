import { encodeFunctionData } from 'viem';
import { settlementAssetAbi } from '@bursar/core';
import { nonceBindsRequest } from './binding.js';
import { assetDomain } from './domain.js';
import { issuerRefusal, isRevert, simulationRefusal } from './issuer.js';
import { refuse, type AuthorizationPath, type MethodContext, type MethodVerdict } from './method.js';
import { readAuthorization, readSignature, sameAddress } from './payload.js';
import { REASON } from './reasons.js';

/**
 * The default path: EIP-3009 `transferWithAuthorization`.
 *
 * The payer signs a transfer instead of sending one, so they need no gas and the relayer
 * broadcasts on their behalf. Replay protection belongs to the token: it records the nonce as
 * spent, which is why a file on this server going missing cannot cause a double spend.
 *
 * Two facts about USDG on Robinhood Chain, both read off the chain on 2026-09-22. It takes the
 * bytes-signature overload of `transferWithAuthorization`, not v/r/s. And gas is ETH there at
 * around 0.05 gwei, so a settlement in the high tens of thousands of gas costs a small fraction
 * of a cent, which is what makes per-call settlement worth doing at all.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

async function check(context: MethodContext): Promise<MethodVerdict> {
  const { chain, asset, payload } = context;

  const authorization = readAuthorization(payload['authorization']);
  const signature = readSignature(payload['signature']);
  if (authorization === null || signature === null) return refuse(REASON.payload);

  // The payer is named in the authorisation, so every refusal below can name them too. A client
  // that gets `insufficient_funds` without knowing which wallet was short cannot act on it.
  const payer = authorization.from;

  if (!sameAddress(authorization.to, context.payTo)) return refuse(REASON.recipient, payer);
  if (authorization.value !== context.required) return refuse(REASON.value, payer);

  if (authorization.validAfter > BigInt(context.now)) return refuse(REASON.early, payer);
  // The authorisation has to outlive the work it pays for as well as the moment it is checked. A
  // sixty-second authorisation fails here, before a fifteen-minute job does the work and finds it
  // cannot charge for it.
  if (authorization.validBefore < BigInt(context.now + context.mustOutlive)) {
    return refuse(REASON.expired, payer);
  }

  // The nonce is derived from the request digest, so the token's own replay protection is what
  // stops this payment being spent against a different call. Nothing extra is signed and nothing
  // extra is stored.
  if (context.binding !== null && !nonceBindsRequest(authorization.nonce, context.binding)) {
    return refuse(REASON.unbound, payer);
  }

  // The domain comes from the token. A guessed one produces a signature that verifies against
  // nothing, with no useful error anywhere in the stack.
  const valid = await chain.verifyTypedData({
    address: payer,
    domain: assetDomain(asset, chain.chainId),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
    signature,
  });
  if (!valid) return refuse(REASON.signature, payer);

  const [balance, spent, controls] = await Promise.all([
    chain.balanceOf(asset.address, payer),
    chain.authorizationState(asset.address, payer, authorization.nonce),
    // The issuer's own controls, in the same wave as the two reads that were already happening.
    // The simulation below would stop a frozen payer too, but all it can report is that the call
    // would revert. Reading the controls is what lets the refusal name the condition, the address
    // it applies to and the party who can lift it.
    chain.issuerControls(asset.address, [payer, authorization.to]),
  ]);
  // A spent nonce is the token reporting that this exact authorisation already settled. That is a
  // replay, not a malformed payload, and it is checked first because it is true whatever the
  // issuer has done since: the money moved.
  if (spent) return refuse(REASON.state, payer, 'authorization already used');

  // Before the balance, because a frozen payer's balance decides nothing.
  const issuer = issuerRefusal(asset, controls, { payer, payee: authorization.to });
  if (issuer !== null) return issuer;

  if (balance < authorization.value) return refuse(REASON.funds, payer);

  const call = {
    to: asset.address,
    data: encodeFunctionData({
      abi: settlementAssetAbi,
      functionName: 'transferWithAuthorization',
      args: [
        authorization.from,
        authorization.to,
        authorization.value,
        authorization.validAfter,
        authorization.validBefore,
        authorization.nonce,
        signature,
      ],
    }),
  } as const;

  try {
    await chain.simulate(call, context.relayer ?? payer);
  } catch (error) {
    // A simulation that never reached the EVM says nothing about the payment. Reporting it as a
    // transaction-state refusal would tell the payer their authorisation is bad when the chain
    // did not answer.
    if (!isRevert(error)) throw error;
    return simulationRefusal(error, asset, { payer, payee: authorization.to });
  }

  return { ok: true, payer, amount: authorization.value, calls: [call] };
}

export const eip3009Path: AuthorizationPath = { method: 'eip3009', check };
