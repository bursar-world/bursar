import { sameAddress } from '@/chain';
import type { Address } from 'viem';

/**
 * Who the connected wallet is, with room for not knowing.
 *
 * The reading that decides a role can fail like any other. "You are not a signer" and "the signer
 * set could not be read" are opposite claims, and a page that renders the second as the first
 * tells an operator holding the right key that they hold the wrong one. So a role has three answers.
 */
export type Answer = 'yes' | 'no' | 'unread';

export type Roles = {
  readonly address: Address | undefined;
  readonly signer: Answer;
  readonly guardian: Answer;
  readonly treasury: Answer;
};

export function answerInList(list: readonly Address[] | undefined, address: Address | undefined): Answer {
  if (address === undefined) return 'no';
  if (list === undefined) return 'unread';
  return list.some((entry) => sameAddress(entry, address)) ? 'yes' : 'no';
}

export function answerIs(expected: Address | undefined, address: Address | undefined): Answer {
  if (address === undefined) return 'no';
  if (expected === undefined) return 'unread';
  return sameAddress(expected, address) ? 'yes' : 'no';
}

/** True where the control should be offered: the role holds, or the reading that would decide it failed. */
export function permits(answer: Answer): boolean {
  return answer !== 'no';
}

export type RoleNotice = {
  readonly headline: string;
  readonly detail: string;
};

/**
 * What the connected wallet may do here, and what to do about it if the answer is nothing.
 *
 * Every line names the condition, whose key it needs and what happens next, because an operator
 * who is refused needs to know which of eight keystores to open rather than that they were refused.
 */
export function governanceNotice(roles: Roles): RoleNotice | undefined {
  if (roles.address === undefined) {
    return {
      headline: 'Connect a signer key to act on a proposal.',
      detail:
        'Everything on this page is public and needs no wallet. Proposing, approving, cancelling and executing need a signer key, and pausing needs the guardian key.',
    };
  }

  if (roles.signer === 'unread' || roles.guardian === 'unread') {
    return {
      headline: 'Could not read the signer set, so this wallet’s role is unknown.',
      detail:
        'The controls below are still offered. If this wallet is not a signer, the timelock refuses the call before anything is sent, at no cost. Read again to confirm.',
    };
  }

  if (roles.signer === 'no' && roles.guardian === 'no') {
    return {
      headline: 'This wallet is not a signer or the guardian, so it can read this page but not change anything.',
      detail:
        'Only the three signers above can propose, approve, cancel and execute, and only the guardian can pause. Connect one of those keys to act here.',
    };
  }

  if (roles.signer === 'no' && roles.guardian === 'yes') {
    return {
      headline: 'This wallet holds the brake and nothing else.',
      detail:
        'It can pause an administered contract at once. It cannot propose, approve, cancel or execute: the contract bars the guardian from the signer set, so a key kept ready for incidents never counts toward the two approvals a change needs.',
    };
  }

  return undefined;
}
