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
        'Everything below is read from the contracts and needs no wallet. Sweeping fees, rotating the treasury and proposing a parameter each need a different one of those keys, and the panel for each says which. Completing a rotation needs the address step one named, and nothing else can do it for it.',
    };
  }

  if (roles.signer === 'unread' || roles.guardian === 'unread' || roles.treasury === 'unread') {
    return {
      admitted: true,
      accepting: true,
      headline: 'The roles could not be read, so what this wallet may do is unknown.',
      detail:
        'The controls are still offered. Each contract refuses a caller it does not recognise, so pressing one costs a refused simulation and no gas. Read again before you rely on what is on screen.',
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
        'Accepting the treasury is the one thing it can do here, and no other key can do it on its behalf. Until it accepts, every swept fee still goes to the address receiving now.',
    };
  }

  return {
    admitted: false,
    // An unread pending slot keeps the offer open for the same reason every other reading here
    // does. The panel above it renders the unread case rather than a handover, so nothing is
    // offered until the escrow has named somebody.
    accepting: permits(roles.incomingTreasury),
    headline: 'This wallet holds none of the roles this surface is for.',
    detail:
      'Sweeping settlement fees needs any funded key and pays the treasury either way. Rotating the treasury needs the treasury key itself, and completing that rotation needs the address it named. Changing a staking or buyback setting needs one of the three signer keys, because a governance delay administers both contracts. Connect one of those to act here.',
  };
}

function roleLine(roles: OpsRoles): string {
  const held: string[] = [];
  if (roles.signer === 'yes') held.push('a timelock signer');
  if (roles.guardian === 'yes') held.push('the guardian');
  if (roles.treasury === 'yes') held.push('the escrow treasury');
  if (roles.incomingTreasury === 'yes') held.push('the successor the escrow treasury has named');

  if (held.length === 0) return 'This wallet holds none of the roles this surface is for.';
  if (held.length === 1) return `This wallet is ${held[0]}.`;
  return `This wallet is ${held.slice(0, -1).join(', ')} and ${held[held.length - 1]}.`;
}

export type ActionNeed = {
  readonly id:
    | 'sweep-fees'
    | 'transfer-treasury'
    | 'accept-treasury'
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
    needs: 'any funded key. The call is permissionless and the escrow pays its treasury whoever sends it.',
    route: 'direct',
  },
  {
    id: 'transfer-treasury',
    title: 'Name a successor to the escrow treasury',
    call: 'Escrow.transferTreasury',
    needs: 'the current treasury key, and nothing else. The timelock cannot make this call.',
    route: 'direct',
  },
  {
    id: 'accept-treasury',
    title: 'Accept the escrow treasury',
    call: 'Escrow.acceptTreasury',
    needs: 'the incoming address itself. Until it accepts, the current treasury keeps receiving.',
    route: 'direct',
  },
  {
    id: 'staking-tiers',
    title: 'Set the staking fee rebate tiers',
    call: 'Staking.setTiers',
    needs: 'one of the three signer keys. The timelock administers the pool, so this is a proposal.',
    route: 'proposal',
  },
  {
    id: 'staking-slasher',
    title: 'Name the slasher on the staking pool',
    call: 'Staking.setSlasher',
    needs: 'one of the three signer keys. The timelock administers the pool, so this is a proposal.',
    route: 'proposal',
  },
  {
    id: 'buyback-ceiling',
    title: 'Set the buyback limits and price ceiling',
    call: 'Buyback.setParams',
    needs: 'one of the three signer keys. The timelock administers the buyback, so this is a proposal.',
    route: 'proposal',
  },
  {
    id: 'buyback-keeper',
    title: 'Name the buyback keeper',
    call: 'Buyback.setKeeper',
    needs: 'one of the three signer keys. The timelock administers the buyback, so this is a proposal.',
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
  'The escrow treasury is a plain key, and it is the only address that can name its successor. The timelock has no reach into it: there is no proposal, no delay and no quorum that can move it. A rotation is two steps, and until the new address accepts, the current one keeps receiving every swept fee. Lose that key with nothing pending and the fee revenue has nowhere to go, permanently.';

/**
 * What a reader needs to know about the sweep before pressing it.
 *
 * Three answers for three conditions. A reading still on its way, a reading that failed and a
 * balance of zero are not the same thing, and the middle one is the one a page usually loses.
 */
export function sweepLine(accrued: bigint | undefined, treasury: string | undefined, read: boolean): string {
  if (!read) return 'Reading what has accrued.';

  if (accrued === undefined) {
    return 'What has accrued could not be read. Nothing here says the balance is zero, and the escrow has not changed; only the reading failed.';
  }
  if (accrued === 0n) {
    return 'Nothing has accrued. Fees arrive as locks release, and the sweep refuses a balance of zero.';
  }
  return treasury === undefined
    ? 'Fees have accrued. Where they go could not be read, so the destination on screen is unknown.'
    : 'Fees have accrued. The sweep sends every one of them to the treasury below and to nowhere else.';
}

/** Whether the sweep can succeed right now. Unread is not zero, so the control stays offered. */
export function canSweep(accrued: bigint | undefined): boolean {
  return accrued === undefined || accrued > 0n;
}

export function answerWord(answer: Answer): string {
  return answer === 'yes' ? 'Yes' : answer === 'no' ? 'No' : 'Not read';
}
