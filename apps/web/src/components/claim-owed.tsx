'use client';

import type { Address } from 'viem';

import { escrowAbi } from '../chain/abi';
import type { AnyState } from '../state';
import { useWriteContract } from '../wallet/write';
import { TxButton } from './tx-button';
import type { TxContext } from './tx-button';

/**
 * Why the escrow is holding a payout and how it comes out, in the same words wherever one is shown.
 * `holder` names who it is held for, the way the page addresses them.
 */
export function owedExplanation(holder: 'this mandate' | 'this address' | 'you'): string {
  return (
    `When the payment settled, USDG refused the transfer to ${holder}, which is what happens while the token ` +
    'issuer has frozen an address. The escrow set that amount aside and settled the rest. Anyone can send the ' +
    `claim. It pays ${holder} and nobody else, and it goes through once USDG accepts the transfer again.`
  );
}

/**
 * Pays out what the escrow is holding for `party`. The escrow takes this call from anyone and pays
 * only `party`, so the button is offered to whichever wallet is looking.
 */
export function ClaimOwedButton({
  escrow,
  party,
  label,
  blockedBy,
  context,
  onClaimed,
}: {
  readonly escrow: Address;
  readonly party: Address;
  readonly label: string;
  readonly blockedBy: readonly AnyState[];
  readonly context?: TxContext;
  readonly onClaimed: () => void;
}) {
  const { writeContractAsync } = useWriteContract();

  return (
    <TxButton
      label={label}
      blockedBy={blockedBy}
      {...(context === undefined ? {} : { context })}
      send={() => writeContractAsync({ address: escrow, abi: escrowAbi, functionName: 'claim', args: [party] })}
      onContinue={onClaimed}
    />
  );
}
