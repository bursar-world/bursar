'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address as EvmAddress, Hex } from 'viem';

import { explorerAddress, explorerTx, shortAddress } from '../chain/rhc';
import { CheckMark, CopyMark, ExternalMark } from '../wallet/logos';
import { IconButton } from './button';

export type AddressProps = {
  readonly value: EvmAddress | string;
  /** Who or what this address is. Supplied, it takes the place of the hex. */
  readonly label?: string;
  readonly full?: boolean;
  readonly copy?: boolean;
  readonly explorer?: boolean;
  readonly className?: string;
};

/**
 * An address on screen.
 *
 * The copy control is an icon. The words "Copy CA" belong to a different kind of product, and a
 * treasurer reading a payment record should see the address, not an instruction.
 */
export function Address({ value, label, full = false, copy = true, explorer = true, className = '' }: AddressProps) {
  // Nothing on mainnet: that explorer is permissioned, and a link most readers cannot open is
  // worse than the address on its own.
  const link = explorer ? explorerAddress(value as EvmAddress) : undefined;

  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 ${className}`}>
      <span className={`tabular text-detail ${full ? 'min-w-0 break-all' : ''}`} title={value}>
        {/* An unregistered name reads back as an empty string, which is no label at all. */}
        {label || (full ? value : shortAddress(value))}
      </span>
      {copy && <CopyControl value={value} />}
      {link !== undefined && (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in the block explorer"
          title="Open in the block explorer"
          className="inline-flex h-7 w-7 items-center justify-center text-[color:var(--color-muted)] transition-colors hover:bg-[color:var(--color-band)] hover:text-[color:var(--color-ink)]"
        >
          <ExternalMark />
        </a>
      )}
    </span>
  );
}

export function CopyControl({ value, label = 'Copy address' }: { readonly value: string; readonly label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'refused'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), state === 'refused' ? 3_000 : 1_500);
    return () => clearTimeout(timer);
  }, [state]);

  const onCopy = useCallback(() => {
    // A page served over plain HTTP has no clipboard at all, so reaching for it throws where a
    // denied permission rejects. Both end with the reader being told. Neither ends with a control
    // that quietly does nothing.
    const written = navigator.clipboard?.writeText(value);
    if (written === undefined) {
      setState('refused');
      return;
    }

    written.then(
      () => setState('copied'),
      () => setState('refused'),
    );
  }, [value]);

  return (
    <IconButton
      label={state === 'copied' ? 'Copied' : state === 'refused' ? 'Could not copy. Select the text instead.' : label}
      onClick={onCopy}
      className={state === 'refused' ? 'text-[color:var(--color-state-blocked)]' : ''}
    >
      {state === 'copied' ? <CheckMark /> : <CopyMark />}
    </IconButton>
  );
}

/** A transaction hash, shortened, copyable and linked where the explorer is open to readers. */
export function TxHash({ hash }: { readonly hash: Hex }) {
  const link = explorerTx(hash);
  const short = shortAddress(hash, 10, 8);

  return (
    <span className="inline-flex items-center gap-1.5">
      {link === undefined ? (
        <span className="tabular text-detail">{short}</span>
      ) : (
        <a href={link} target="_blank" rel="noreferrer" className="tabular text-detail underline underline-offset-2">
          {short}
        </a>
      )}
      <CopyControl value={hash} label="Copy transaction hash" />
    </span>
  );
}
