import { encodeFunctionData, parseAbi } from 'viem';
import { deriveNonce } from './binding.js';
import { issuerRefusal, isRevert, simulationRefusal } from './issuer.js';
import { refuse, type AuthorizationPath, type MethodContext, type MethodVerdict } from './method.js';
import { readPermit2, readSignature, sameAddress } from './payload.js';
import { REASON } from './reasons.js';
import type { Eip712DomainFields } from './ports.js';

/**
 * The Permit2 path: one transaction, but only after the payer has approved Permit2 once.
 *
 * Uniswap's Permit2 sits at the same address on every chain it has been deployed to, and
 * Robinhood Chain is one of them: the canonical address holds code there, read on 2026-09-22.
 * The bytecode is not compared across chains because Permit2 caches the chain id in an immutable,
 * so its runtime code legitimately differs per chain. A payer approves Permit2 on the token once,
 * ever, and afterwards signs transfers instead of sending approvals.
 *
 * Its nonces are an unordered bitmap, not a counter, so the client picks its own. That is
 * what lets the request digest be folded into the nonce here exactly as it is on the EIP-3009
 * path, and Permit2 refuses a reused bit, so the binding is enforced on chain.
 *
 * The recipient is not signed, so the payer trusts the relayer to forward the funds. Same trade as
 * EIP-2612, same reason EIP-3009 leads.
 */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

export const PERMIT_TRANSFER_FROM_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

/** Permit2 omits `version` from its EIP712Domain, so a domain that carries one hashes wrong. */
export function permit2Domain(permit2: `0x${string}`, chainId: number): Eip712DomainFields {
  return { name: 'Permit2', chainId, verifyingContract: permit2 };
}

export const permit2Abi = parseAbi([
  'struct TokenPermissions { address token; uint256 amount; }',
  'struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }',
  'struct SignatureTransferDetails { address to; uint256 requestedAmount; }',
  'function permitTransferFrom(PermitTransferFrom permit, SignatureTransferDetails transferDetails, address owner, bytes signature)',
  'function nonceBitmap(address owner, uint256 word) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]);

/** A Permit2 nonce addresses one bit: the high 248 bits pick the word, the low 8 pick the bit. */
export function noncePosition(nonce: bigint): { readonly word: bigint; readonly bit: bigint } {
  return { word: nonce >> 8n, bit: nonce & 0xffn };
}

export function nonceIsSpent(bitmap: bigint, nonce: bigint): boolean {
  return ((bitmap >> noncePosition(nonce).bit) & 1n) === 1n;
}

async function check(context: MethodContext): Promise<MethodVerdict> {
  const { chain, asset, payload } = context;

  const transfer = readPermit2(payload['permit']);
  const signature = readSignature(payload['signature']);
  if (transfer === null || signature === null) return refuse(REASON.payload);

  const payer = transfer.owner;

  if (context.permit2 === null) {
    return refuse(REASON.method, payer, 'permit2 is not configured for this network');
  }
  if (context.relayer === null) {
    return refuse(REASON.method, payer, 'permit2 settlement needs a configured relayer');
  }
  if (!sameAddress(transfer.token, asset.address)) return refuse(REASON.requirements, payer, 'permit names another token');
  if (!sameAddress(transfer.spender, context.relayer)) return refuse(REASON.spender, payer);
  if (transfer.amount !== context.required) return refuse(REASON.value, payer);
  if (transfer.deadline < BigInt(context.now + context.mustOutlive)) return refuse(REASON.expired, payer);

  if (context.binding !== null && transfer.nonce !== BigInt(deriveNonce(context.binding))) {
    return refuse(REASON.unbound, payer);
  }

  const valid = await chain.verifyTypedData({
    address: payer,
    domain: permit2Domain(context.permit2, chain.chainId),
    types: PERMIT_TRANSFER_FROM_TYPES,
    primaryType: 'PermitTransferFrom',
    message: {
      permitted: { token: transfer.token, amount: transfer.amount },
      spender: transfer.spender,
      nonce: transfer.nonce,
      deadline: transfer.deadline,
    },
    signature,
  });
  if (!valid) return refuse(REASON.signature, payer);

  const { word } = noncePosition(transfer.nonce);
  const [balance, approved, bitmap, controls] = await Promise.all([
    chain.balanceOf(asset.address, payer),
    // Permit2 moves the funds with the token's own allowance, which the payer grants once. Without
    // it every settlement reverts, and the refusal is worth naming: the fix is a one-off approval,
    // and re-signing changes nothing.
    chain.allowance(asset.address, payer, context.permit2),
    chain.nonceBitmap(context.permit2, payer, word),
    // The token applies its issuer controls to the transfer Permit2 makes like any other, so they
    // are read here as they are on every other path.
    chain.issuerControls(asset.address, [payer, context.payTo]),
  ]);
  if (nonceIsSpent(bitmap, transfer.nonce)) {
    return refuse(REASON.state, payer, 'permit2 nonce already used');
  }

  const issuer = issuerRefusal(asset, controls, { payer, payee: context.payTo });
  if (issuer !== null) return issuer;

  if (balance < transfer.amount) return refuse(REASON.funds, payer);
  if (approved < transfer.amount) return refuse(REASON.permit2Allowance, payer);

  const call = {
    to: context.permit2,
    data: encodeFunctionData({
      abi: permit2Abi,
      functionName: 'permitTransferFrom',
      args: [
        {
          permitted: { token: transfer.token, amount: transfer.amount },
          nonce: transfer.nonce,
          deadline: transfer.deadline,
        },
        { to: context.payTo, requestedAmount: transfer.amount },
        transfer.owner,
        signature,
      ],
    }),
  } as const;

  try {
    await chain.simulate(call, context.relayer);
  } catch (error) {
    // As on the EIP-3009 path: a simulation that never reached the EVM is not a verdict on the
    // payment, so it propagates instead of becoming a refusal.
    if (!isRevert(error)) throw error;
    return simulationRefusal(error, asset, { payer, payee: context.payTo });
  }

  return { ok: true, payer, amount: transfer.amount, calls: [call] };
}

export const permit2Path: AuthorizationPath = { method: 'permit2', check };
