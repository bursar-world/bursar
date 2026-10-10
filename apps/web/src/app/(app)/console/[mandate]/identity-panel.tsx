'use client';

import { isZeroAddress } from '@/chain/rhc';
import { IdentitySection } from '../../providers/identity';
import { callGates } from '../lib/write-gates';
import { useMandateScope } from './mandate-scope';

/** The mandate's agent as an ERC-8004 identity, held by the owner and pointing at the mandate's card. */
export function IdentityPanel() {
  const { address, account, system, isOwner, connected, writeContext } = useMandateScope();
  if (!account) return null;

  const seated = !isZeroAddress(account.agent);
  return (
    <IdentitySection
      subject={address}
      owner={account.principal}
      kind="mandate"
      canRegister={isOwner && seated}
      {...(isOwner && !seated ? { heldBack: 'Seat an agent first. The card describes who spends from this mandate.' } : {})}
      {...(connected !== undefined && !isOwner ? { heldBack: "Only the mandate owner's wallet can register the agent's identity." } : {})}
      blockedBy={callGates(system)}
      context={writeContext}
    />
  );
}
