'use client';

import { useMemo, useState } from 'react';
import type { Connector } from 'wagmi';
import { useConnect, useConnectors } from 'wagmi';

import { Modal } from '../components/modal';
import { ErrorSurface } from '../components/error-surface';
import { BrowserWalletMark, SafeMark, WalletConnectMark } from './logos';
import { WALLETCONNECT_CONFIGURED } from './config';

/**
 * The wallet picker.
 *
 * Wallets that announce themselves over EIP-6963 supply their own name and their own icon, so a
 * reader sees the artwork their wallet ships. A bundled copy would go stale.
 * WalletConnect and Safe do not announce, so their marks live in this repo.
 *
 * Safe is on the list because the principal on a mandate is often a Safe. The contracts already
 * verify its signatures, and nothing in this app ever asks for a key.
 */
export function ConnectModal({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const connectors = useConnectors();
  const { connectAsync, isPending } = useConnect();
  const [attempting, setAttempting] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const options = useMemo(() => rank(connectors), [connectors]);

  const choose = async (connector: Connector) => {
    setError(null);
    setAttempting(connector.uid);
    try {
      await connectAsync({ connector });
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setAttempting(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect a wallet"
      description="BURSAR never holds a key. Every action is signed in your own wallet."
    >
      <ul className="space-y-2">
        {options.map((connector) => (
          <li key={connector.uid}>
            <button
              type="button"
              disabled={isPending && attempting !== connector.uid}
              onClick={() => void choose(connector)}
              className="flex w-full items-center gap-3 rounded-md border border-[color:var(--color-line)] px-3 py-2.5 text-left transition-colors hover:bg-[color:var(--color-raised)] disabled:opacity-50"
            >
              <ConnectorMark connector={connector} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{displayName(connector)}</span>
                <span className="block text-note text-[color:var(--color-muted)]">{describe(connector)}</span>
              </span>
              {attempting === connector.uid && <span className="text-note text-[color:var(--color-muted)]">Waiting</span>}
            </button>
          </li>
        ))}
      </ul>

      {!WALLETCONNECT_CONFIGURED && (
        <p className="mt-3 text-note text-[color:var(--color-muted)]">
          Mobile wallets connect over WalletConnect, which this build does not have a project id for.
        </p>
      )}

      {error !== null && (
        <div className="mt-3">
          <ErrorSurface error={error} action="Connecting" />
        </div>
      )}
    </Modal>
  );
}

function ConnectorMark({ connector }: { readonly connector: Connector }) {
  if (connector.icon) {
    return <img src={connector.icon} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-md" />;
  }
  if (connector.id === 'walletConnect') return <WalletConnectMark size={28} className="shrink-0" />;
  if (connector.id === 'safe') return <SafeMark size={28} className="shrink-0" />;
  return <BrowserWalletMark size={28} className="shrink-0" />;
}

function displayName(connector: Connector): string {
  if (connector.id === 'safe') return 'Safe';
  if (connector.id === 'walletConnect') return 'WalletConnect';
  if (connector.id === 'injected' && connector.name === 'Injected') return 'Browser wallet';
  return connector.name;
}

function describe(connector: Connector): string {
  if (connector.id === 'safe') return 'Connects when BURSAR is opened inside your Safe.';
  if (connector.id === 'walletConnect') return 'Scan a code with a mobile wallet.';
  if (connector.type === 'injected') return 'Installed in this browser.';
  return 'Wallet';
}

/**
 * Discovered wallets first, then WalletConnect, then Safe. The generic injected entry is dropped
 * whenever a real wallet announced itself, because the two rows are the same wallet.
 */
function rank(connectors: readonly Connector[]): readonly Connector[] {
  const discovered = connectors.filter((connector) => connector.type === 'injected' && connector.id !== 'injected');
  const generic = connectors.filter((connector) => connector.id === 'injected');
  const walletConnect = connectors.filter((connector) => connector.id === 'walletConnect');
  const safe = connectors.filter((connector) => connector.id === 'safe');

  return [...discovered, ...(discovered.length > 0 ? [] : generic), ...walletConnect, ...safe];
}
