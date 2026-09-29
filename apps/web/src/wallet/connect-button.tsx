'use client';

import { useState } from 'react';
import { useDisconnect } from 'wagmi';

import { CHAIN_ID, explorerAddress, shortAddress } from '../chain/rhc';
import { Button } from '../components/button';
import { CopyControl } from '../components/address';
import { Modal } from '../components/modal';
import { useWalletAccount } from './account';
import { ConnectModal } from './connect-modal';
import { SwitchNetworkButton } from './switch-network';

/**
 * Connect, or the connected account.
 *
 * A wallet on the wrong network is its own state and gets its own prompt. Letting it through and
 * failing at signing time puts the discovery after the decision.
 */
export function ConnectButton() {
  const { address, isConnected, connector, chainId } = useWalletAccount();
  const { disconnect } = useDisconnect();
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(false);

  if (!isConnected || !address) {
    return (
      <>
        <Button tone="primary" size="sm" onClick={() => setPicking(true)}>
          Connect wallet
        </Button>
        <ConnectModal open={picking} onClose={() => setPicking(false)} />
      </>
    );
  }

  if (chainId !== CHAIN_ID) {
    return <SwitchNetworkButton size="sm" />;
  }

  // Nothing on mainnet: that explorer is permissioned, so the row is dropped. A link most readers
  // cannot open is worse than no link.
  const explorerLink = explorerAddress(address);

  return (
    <>
      <Button tone="secondary" size="sm" onClick={() => setOpen(true)}>
        <span className="tabular">{shortAddress(address)}</span>
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Connected account" description={connector?.name}>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-md border border-[color:var(--color-line)] px-3 py-2">
            <span className="tabular text-detail break-all">{address}</span>
            <CopyControl value={address} />
          </div>
          {explorerLink !== undefined && (
            <a href={explorerLink} target="_blank" rel="noreferrer" className="block text-detail underline underline-offset-2">
              Open in the block explorer
            </a>
          )}
          <Button
            tone="secondary"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </Button>
        </div>
      </Modal>
    </>
  );
}
