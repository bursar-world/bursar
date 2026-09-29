'use client';

import { useState } from 'react';
import type { Address, Hex } from 'viem';
import { disclosureRegistryAbi } from '@bursar/core';
import { disclosureSlice, isSealedURI, publishedViewingKey, readJobURI } from '@bursar/sdk';
import type { TermsDocument } from '@bursar/sdk';

import { rhcClient } from '@/chain/client';
import { privateContracts } from '@/chain/private';
import { AddressInput, readAddress } from '@/components/address-input';
import { TxButton } from '@/components/tx-button';
import { useWriteContract } from '@/wallet/write';

/**
 * The job input as the payer can read it off the lock, when it can. A sealed input is readable by
 * the provider alone, so the payer shares what it holds instead: nothing.
 */
export function readableInput(inputURI: string): unknown {
  if (inputURI === '' || isSealedURI(inputURI)) return null;
  try {
    return readJobURI(inputURI);
  } catch {
    return null;
  }
}

/**
 * Shares the disputed slice of one payment with one resolver.
 *
 * The slice is the job input, and for a private mandate the terms with this provider's place in the
 * list. It is sealed to the resolver's published viewing key, so the grant on chain is readable by
 * that resolver and nobody else, and it says nothing about any other payment.
 */
export function ShareWithResolver({
  escrow,
  lockId,
  inputURI,
  payee,
  terms,
}: {
  readonly escrow: Address;
  readonly lockId: bigint;
  readonly inputURI: string;
  readonly payee: Address;
  readonly terms?: TermsDocument;
}) {
  const contracts = privateContracts();
  const { writeContractAsync } = useWriteContract();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  if (contracts === undefined) return null;
  if (!open) {
    return (
      <button type="button" className="text-detail underline underline-offset-2" onClick={() => setOpen(true)}>
        Share with a resolver
      </button>
    );
  }

  const resolver = readAddress(text).value;

  const send = async (): Promise<Hex> => {
    if (!resolver) throw new Error('Enter the resolver address.');
    setProblem(undefined);
    const key = await publishedViewingKey(rhcClient(), resolver);
    if (key === null) {
      const message = 'This resolver has not published a viewing key, so there is no way to seal the slice to it. Ask it to register one.';
      setProblem(message);
      throw new Error(message);
    }
    const { sliceCommit, ciphertext } = await disclosureSlice({
      escrow,
      lockId,
      input: readableInput(inputURI),
      ...(terms ? { terms, payee } : {}),
      resolverViewingKey: key,
    });
    return writeContractAsync({
      address: contracts.DisclosureRegistry,
      abi: disclosureRegistryAbi,
      functionName: 'grant',
      args: [escrow, lockId, resolver, sliceCommit, ciphertext],
    });
  };

  return (
    <div className="space-y-2 text-left">
      <AddressInput
        label="Resolver address"
        value={text}
        onChange={setText}
        hint={terms ? 'The resolver sees this payment, the input and the terms it turns on.' : 'The resolver sees this payment and its input.'}
      />
      <TxButton label="Share the slice" tone="secondary" disabled={resolver === undefined} send={send} />
      {problem && (
        <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
          {problem}
        </p>
      )}
    </div>
  );
}
