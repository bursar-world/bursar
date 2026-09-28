'use client';

import { useState } from 'react';
import type { Micro } from '@bursar/core';

import { ADDRESSES } from '@/chain/rhc';
import { mandateAccountAbi, settlementAssetAbi } from '@/chain/abi';
import { AmountInput } from '@/components/amount-input';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { TxButton } from '@/components/tx-button';
import { formatEth, usd, usdg } from '@/money';
import { ROUND_TRIP_FEE } from '@/state';
import { fundingAmounts } from '../lib/amount';
import { transferGates } from '../lib/write-gates';
import { useMandateScope } from './mandate-scope';
import { useWriteContract } from '@/wallet/write';

/**
 * The two balances, in two assets, kept apart.
 *
 * The mandate holds USDG and that pays providers. The connected wallet holds ETH and that pays
 * transaction fees. They are neither added nor compared: a mandate full of USDG and a wallet with
 * no ETH settles nothing, and the reader has to be able to see which of the two is short.
 */
export function FundingPanel() {
  const { address, account, ledger, system, isOwner, connected, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();

  const [depositText, setDepositText] = useState('');
  const [withdrawText, setWithdrawText] = useState('');

  if (!account) return null;

  const gas = system.funding.facts.gasBalance;
  const balance = account.balance;
  const trips = gas === undefined ? undefined : gas / ROUND_TRIP_FEE;
  const allowance = ledger.allowance;
  // An allowance the token did not report is not an allowance that exists. Sending the deposit on
  // that reading puts the fee on the owner for a call that reverts inside transferFrom, so the
  // unknown takes the same route as a short allowance: set it, then move the money.
  const allowanceUnread = allowance === undefined;

  const wallet = ledger.ownerBalance;
  const { deposit, withdraw } = fundingAmounts({ depositText, withdrawText, wallet, held: balance });

  const depositAmount = deposit.value;
  const withdrawAmount = withdraw.value;
  const needsAllowance = depositAmount !== undefined && (allowance === undefined || allowance < depositAmount);
  const gates = transferGates(system);

  return (
    <Section title="Funding" description="What pays providers, and what pays the fee to send a transaction.">
      <Card>
        <div className="space-y-6">
          <StatGrid columns={3}>
            <Stat
              label="The mandate holds, for payments"
              value={usdg(balance)}
              hint={
                balance === 0n
                  ? 'No USDG to pay a provider with. A payment is refused before the escrow takes it.'
                  : 'USDG. This is what a provider is paid out of, and it never pays a transaction fee.'
              }
              level={balance === 0n ? 'blocked' : 'ok'}
            />
            <Stat
              label="Your wallet holds, for fees"
              value={gas === undefined ? 'Unread' : formatEth(gas)}
              hint={
                connected === undefined
                  ? 'Connect a wallet to see what it can pay in fees.'
                  : trips === undefined
                    ? 'ETH. A different asset from the one the mandate holds.'
                    : `ETH, about ${trips.toString()} more payment${trips === 1n ? '' : 's'}. Topping up the mandate does nothing for this.`
              }
              level={gas === undefined ? 'unknown' : gas < ROUND_TRIP_FEE ? 'blocked' : 'ok'}
            />
            <Stat
              label="One payment costs"
              value={formatEth(ROUND_TRIP_FEE)}
              hint="One lock through the mandate and one release by the provider, at the fee this chain has been charging."
            />
          </StatGrid>

          {isOwner && (
            <FieldGrid columns={2}>
              <Field
                label="Add funds"
                hint="Two transactions: the token is told the account may take the amount, then the account takes it and records it."
              >
                <div className="space-y-3">
                  <AmountInput
                    label="Amount"
                    asset="USDG"
                    value={depositText}
                    onChange={setDepositText}
                    {...(wallet === undefined ? {} : { max: { atomic: wallet, label: 'All of it' } })}
                    {...(depositText.trim() === '' || deposit.problem === undefined ? {} : { problem: deposit.problem })}
                    hint={
                      wallet === undefined
                        ? 'What your wallet holds could not be read, so this field cannot check the amount against it.'
                        : `Your wallet holds ${usd(wallet)}.`
                    }
                  />
                  {needsAllowance ? (
                    <div className="space-y-2">
                      <TxButton
                        label="Allow the account to take it"
                        tone="secondary"
                        disabled={depositAmount === undefined}
                        blockedBy={gates}
                        context={{ ...writeContext, ...(depositAmount === undefined ? {} : { amount: depositAmount }) }}
                        send={() =>
                          writeContractAsync({
                            address: ADDRESSES.usdg,
                            abi: settlementAssetAbi,
                            functionName: 'approve',
                            args: [address, depositAmount as Micro],
                          })
                        }
                        onContinue={refresh}
                      />
                      {allowanceUnread && (
                        <p className="text-detail" style={{ color: 'var(--color-state-unknown)' }}>
                          {ledger.isLoading
                            ? 'The token is still being read for what this account may already take, so the allowance is set again and nothing is assumed.'
                            : 'The token did not answer what this account is already allowed to take, so the allowance is set again. A deposit sent on a reading nobody took reverts and still costs the fee.'}
                        </p>
                      )}
                    </div>
                  ) : (
                    <TxButton
                      label="Move the funds in"
                      disabled={depositAmount === undefined}
                      blockedBy={gates}
                      context={{ ...writeContext, ...(depositAmount === undefined ? {} : { amount: depositAmount }) }}
                      send={() =>
                        writeContractAsync({
                          address,
                          abi: mandateAccountAbi,
                          functionName: 'deposit',
                          args: [depositAmount as Micro],
                        })
                      }
                      onConfirmed={() => {
                        setDepositText('');
                        refresh();
                      }}
                    />
                  )}
                </div>
              </Field>

              <Field label="Take funds out" hint="The owner can withdraw the whole balance at any time. Money already locked in the escrow is not part of it.">
                <div className="space-y-3">
                  <AmountInput
                    label="Amount"
                    asset="USDG"
                    value={withdrawText}
                    onChange={setWithdrawText}
                    max={{ atomic: balance, label: 'All of it' }}
                    {...(withdrawText.trim() === '' || withdraw.problem === undefined ? {} : { problem: withdraw.problem })}
                    hint={`This mandate holds ${usd(balance)}. It goes back to ${connected === undefined ? 'the connected wallet' : 'your wallet'}.`}
                  />
                  <TxButton
                    label="Send it back to your wallet"
                    tone="secondary"
                    disabled={withdrawAmount === undefined || connected === undefined}
                    blockedBy={gates}
                    context={{ ...writeContext, ...(withdrawAmount === undefined ? {} : { amount: withdrawAmount }) }}
                    send={() =>
                      writeContractAsync({
                        address,
                        abi: mandateAccountAbi,
                        functionName: 'withdraw',
                        args: [ADDRESSES.usdg, connected as `0x${string}`, withdrawAmount as Micro],
                      })
                    }
                    onConfirmed={() => {
                      setWithdrawText('');
                      refresh();
                    }}
                  />
                </div>
              </Field>
            </FieldGrid>
          )}

          {!isOwner && (
            <p className="text-detail text-[color:var(--color-muted)]">
              Anyone can send USDG to this address to fund it. Only the owner can take it out.
            </p>
          )}

        </div>
      </Card>
    </Section>
  );
}
