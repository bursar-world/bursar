import { permits } from '../governance/roles';
import type { Answer, Roles } from '../governance/roles';

/**
 * Who this surface is for, and what each control on it needs.
 *
 * Three different keys do the four things here, and they are not interchangeable. A page that
 * offers all four to everyone and lets the chain sort it out sends an operator to a wallet prompt
 * that ends in a revert. Every line below names the condition, whose key it needs and what
 * happens next.
 */

/**
 * The connected wallet against every role this surface knows about.
 *
 * The fourth is the address the escrow treasury has named and is waiting on. It holds none of the
 * other three: a rotation is usually made to a fresh multisig, which has no signer seat, no
 * guardian key and no fee revenue until it accepts. Reading it as "none of the three" would leave
 * the only address that can finish a rotation looking at a page with nothing on it.
 */
export type OpsRoles = Roles & { readonly incomingTreasury: Answer };

export type OpsAccess = {
  /** Whether the controls are rendered at all. The readings above them are public either way. */
  readonly admitted: boolean;
  /**
   * Whether step two of the treasury rotation is offered. It is the one control a wallet holding
   * no other role here can reach, and it reaches nothing else.
   */
  readonly accepting: boolean;
  readonly headline: string;
  readonly detail: string;
};

export function opsAccess(roles: OpsRoles): OpsAccess {
  if (roles.address === undefined) {
    return {
      admitted: false,
      accepting: false,
      headline: 'Connect a signer, the guardian, the escrow treasury key or the address it has named.',
      detail:
        'Everything below is public and needs no wallet. Each action needs one of those keys, and each panel says which.',
    };
  }

  if (roles.signer === 'unread' || roles.guardian === 'unread' || roles.treasury === 'unread') {
    return {
      admitted: true,
      accepting: true,
      headline: 'Could not read this wallet’s roles, so what it can do is unknown.',
      detail:
        'The controls are still offered. A contract refuses a caller it does not recognise before anything is sent, at no cost. Read again to confirm.',
    };
  }

  if (permits(roles.signer) || permits(roles.guardian) || permits(roles.treasury)) {
    return {
      admitted: true,
      accepting: true,
      headline: roleLine(roles),
      detail: 'Each panel below names the key its action needs.',
    };
  }

  if (roles.incomingTreasury === 'yes') {
    return {
      admitted: false,
      accepting: true,
      headline: 'This wallet is the successor the escrow treasury has named.',
      detail:
        'Accepting the treasury is the one thing it can do here, and no other key can do it for it. Until it accepts, swept fees still go to the current treasury.',
    };
  }

  return {
    admitted: false,
    // An unread pending slot keeps the offer open for the same reason every other reading here
    // does. The panel above it renders the unread case rather than a handover, so nothing is
    // offered until the escrow has named somebody.
    accepting: permits(roles.incomingTreasury),
    headline: 'This wallet holds none of the roles this page is for.',
    detail:
      'Anyone can sweep settlement fees, and the sweep always pays the treasury. Rotating the treasury needs the treasury key itself, and the address it named completes it. Changing a staking or buyback setting needs one of the three signer keys. Connect one of those to act here.',
  };
}

function roleLine(roles: OpsRoles): string {
  const held: string[] = [];
  if (roles.signer === 'yes') held.push('a timelock signer');
  if (roles.guardian === 'yes') held.push('the guardian');
  if (roles.treasury === 'yes') held.push('the escrow treasury');
  if (roles.incomingTreasury === 'yes') held.push('the successor the escrow treasury has named');

  if (held.length === 0) return 'This wallet holds none of the roles this page is for.';
  if (held.length === 1) return `This wallet is ${held[0]}.`;
  return `This wallet is ${held.slice(0, -1).join(', ')} and ${held[held.length - 1]}.`;
}

export type ActionNeed = {
  readonly id:
    | 'sweep-fees'
    | 'transfer-treasury'
    | 'accept-treasury'
    | 'claim-seized'
    | 'staking-tiers'
    | 'staking-slasher'
    | 'buyback-ceiling'
    | 'buyback-keeper';
  readonly title: string;
  /** The call behind the control, spelled the way the contract spells it. */
  readonly call: string;
  /** Which key has to send it. */
  readonly needs: string;
  /** Whether it goes straight to the contract or waits out the governance delay. */
  readonly route: 'direct' | 'proposal';
};

export const NEEDS: readonly ActionNeed[] = [
  {
    id: 'sweep-fees',
    title: 'Sweep settlement fees to the treasury',
    call: 'Escrow.sweepFees',
    needs: 'Any funded key. Anyone can call it, and the escrow pays its treasury whoever sends it.',
    route: 'direct',
  },
  {
    id: 'transfer-treasury',
    title: 'Name a successor to the escrow treasury',
    call: 'Escrow.transferTreasury',
    needs: 'The current treasury key, and nothing else. Governance cannot make this call.',
    route: 'direct',
  },
  {
    id: 'accept-treasury',
    title: 'Accept the escrow treasury',
    call: 'Escrow.acceptTreasury',
    needs: 'The incoming address itself. Until it accepts, the current treasury keeps receiving.',
    route: 'direct',
  },
  {
    id: 'claim-seized',
    title: 'Pay seized collateral to the credit pool’s lender',
    call: 'CollateralVault.claimSeized',
    needs: 'Any funded key. Anyone can call it, and the vault pays the pool’s lender whoever sends it.',
    route: 'direct',
  },
  {
    id: 'staking-tiers',
    title: 'Set the staking fee rebate tiers',
    call: 'Staking.setTiers',
    needs: 'One of the three signer keys. Governance administers the pool, so this is a proposal.',
    route: 'proposal',
  },
  {
    id: 'staking-slasher',
    title: 'Name the slasher on the staking pool',
    call: 'Staking.setSlasher',
    needs: 'One of the three signer keys. Governance administers the pool, so this is a proposal.',
    route: 'proposal',
  },
  {
    id: 'buyback-ceiling',
    title: 'Set the buyback limits and price ceiling',
    call: 'Buyback.setParams',
    needs: 'One of the three signer keys. Governance administers the buyback, so this is a proposal.',
    route: 'proposal',
  },
  {
    id: 'buyback-keeper',
    title: 'Name the buyback keeper',
    call: 'Buyback.setKeeper',
    needs: 'One of the three signer keys. Governance administers the buyback, so this is a proposal.',
    route: 'proposal',
  },
];

export function needFor(id: ActionNeed['id']): ActionNeed {
  const found = NEEDS.find((entry) => entry.id === id);
  if (!found) throw new Error(`No operator action named ${id}.`);
  return found;
}

/** The sentence the treasury panel owes a reader before they touch either step. */
export const TREASURY_WARNING =
  'Only the escrow treasury can name its successor. Governance cannot move it: no proposal, delay or quorum reaches it. A rotation takes two steps, and the current treasury keeps receiving every swept fee until the new address accepts. If that key is lost with no handover pending, the fee revenue has nowhere to go, permanently.';

/**
 * What a reader needs to know about the sweep before pressing it.
 *
 * Three answers for three conditions. A reading still on its way, a reading that failed and a
 * balance of zero are not the same thing, and the middle one is the one a page usually loses.
 */
export function sweepLine(accrued: bigint | undefined, treasury: string | undefined, read: boolean): string {
  if (!read) return 'Reading what has accrued.';

  if (accrued === undefined) {
    return 'Could not read what has accrued. It may not be zero, so the sweep stays available.';
  }
  if (accrued === 0n) {
    return 'Nothing is waiting to be swept. Fees accrue here as payments release.';
  }
  return treasury === undefined
    ? 'Fees have accrued. Could not read the treasury they go to.'
    : 'Fees have accrued. The sweep sends all of them to the treasury below, and nowhere else.';
}

/** Whether the sweep can succeed right now. Unread is not zero, so the control stays offered. */
export function canSweep(accrued: bigint | undefined): boolean {
  return accrued === undefined || accrued > 0n;
}

/**
 * What a reader needs to know about seized collateral before pressing claim. A lane whose vault
 * does not seize is told so, and an empty list is told apart from a reading that failed.
 */
export function seizedLine(seized: { readonly assets: readonly unknown[]; readonly complete: boolean } | undefined, read: boolean): string {
  if (!read) return 'Reading what has been seized.';
  if (seized === undefined) {
    return 'This vault holds no seized collateral. It leaves a written-off line holding what could not be sold, so there is nothing to claim here.';
  }
  if (!seized.complete) {
    return 'Could not read everything that has been seized. What is listed is accurate, and anything missing is unknown, not zero.';
  }
  if (seized.assets.length === 0) return 'Nothing is waiting to be claimed. Collateral lands here when a line is written off with some of it still posted.';
  return 'Collateral taken from written-off lines is waiting. Each claim pays the whole amount in that asset to the lender below, and nowhere else.';
}

export function answerWord(answer: Answer): string {
  return answer === 'yes' ? 'Yes' : answer === 'no' ? 'No' : 'Not read';
}
