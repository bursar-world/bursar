'use client';

import type { Address } from 'viem';

import { escrowAbi } from '../chain/abi';
import type { AnyState } from '../state';
import { useWriteContract } from '../wallet/write';
import { TxButton } from './tx-button';
import type { TxContext } from './tx-button';

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
