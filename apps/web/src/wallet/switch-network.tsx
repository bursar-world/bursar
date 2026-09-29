'use client';

import { useState } from 'react';
import { useSwitchChain } from 'wagmi';

import { CHAIN_ID, RHC } from '../chain/rhc';
import { Button } from '../components/button';
import type { ButtonTone } from '../components/button';
import { isUserRejection } from '../lib/revert';

/** Why the last switch did not happen, in the reader's terms. */
export function switchRefusal(error: unknown): string {
  if (isUserRejection(error)) {
    return `Your wallet stayed on its current network, so nothing was sent. Switch to ${RHC.name} to continue.`;
  }
  return `Your wallet could not switch to ${RHC.name}. Add the network in your wallet, or switch to it there, then try again.`;
}

/**
 * The one way onto the deployment chain, with the answer when the wallet says no.
 *
 * A switch the reader turned down used to leave the button exactly as it was, which reads as the
 * product ignoring the press. The refusal is named instead.
 */
export function SwitchNetworkButton({
  size,
  tone = 'primary',
  reason,
}: {
  readonly size?: 'sm';
  readonly tone?: ButtonTone;
  /** What the switch is for, shown under the button: "Switch to Robinhood Chain to change this mandate." */
  readonly reason?: string;
}) {
  const { switchChain, isPending } = useSwitchChain();
  const [refused, setRefused] = useState<string | undefined>(undefined);

  return (
    <div className="space-y-2">
      <Button
        tone={tone}
        size={size}
        disabled={isPending}
        onClick={() => {
          setRefused(undefined);
          switchChain({ chainId: CHAIN_ID }, { onError: (error) => setRefused(switchRefusal(error)) });
        }}
      >
        {isPending ? `Switching to ${RHC.name}` : `Switch to ${RHC.name}`}
      </Button>
      {reason !== undefined && refused === undefined && <p className="text-detail text-[color:var(--color-muted)]">{reason}</p>}
      {refused !== undefined && (
        <p role="alert" className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
          {refused}
        </p>
      )}
    </div>
  );
}
