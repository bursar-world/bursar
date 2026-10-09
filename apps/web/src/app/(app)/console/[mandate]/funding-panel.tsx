'use client';

import { useState } from 'react';
import type { Micro } from '@bursar/core';
import type { Hex } from 'viem';

import { ADDRESSES, explorerTx } from '@/chain/rhc';
import { mandateAccountAbi, settlementAssetAbi } from '@/chain/abi';
import { AmountInput } from '@/components/amount-input';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { TxButton } from '@/components/tx-button';
import { formatEthApprox, formatEthBalance, usd, usdHeld } from '@/money';
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
  // The approval that just landed, and for how much. Its receipt is the token saying yes, so the
  // second step is offered on it rather than on a re-read that a lagging node can still answer no.
  const [approved, setApproved] = useState<{ readonly hash: Hex; readonly amount: Micro } | undefined>(undefined);

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
  const approvedNow = approved !== undefined && depositAmount !== undefined && approved.amount >= depositAmount;
  const needsAllowance = depositAmount !== undefined && !approvedNow && (allowance === undefined || allowance < depositAmount);
  const gates = transferGates(system);

  return (
    <Section title="Funding" description="USDG in the mandate pays providers. ETH in your wallet pays network fees.">
      <Card>
        <div className="space-y-6">
          <StatGrid columns={connected === undefined ? 2 : 3}>
            <Stat
              label="The mandate holds, for payments"
              value={usdHeld(balance)}
              hint={
                balance === 0n
                  ? 'No USDG yet. Payments are refused until it is funded.'
                  : 'USDG that pays providers.'
              }
              level={balance === 0n ? 'blocked' : 'ok'}
            />
            {connected !== undefined && (
              <Stat
                label="Your wallet holds, for fees"
                value={gas === undefined ? 'Not read' : formatEthBalance(gas)}
                hint={
                  trips === undefined
                    ? 'ETH for network fees.'
                    : `Enough for about ${trips.toString()} more payment${trips === 1n ? '' : 's'}.`
                }
                level={gas === undefined ? 'unknown' : gas < ROUND_TRIP_FEE ? 'blocked' : 'ok'}
              />
            )}
            <Stat
              label="One payment costs"
              value={formatEthApprox(ROUND_TRIP_FEE)}
              hint="Network fees for one payment and its release, at current prices."
            />
          </StatGrid>

          {isOwner && (
            <FieldGrid columns={2}>
              <Field
                label="Add funds"
                hint="Two steps: approve the amount, then move it in."
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
                        ? 'Your wallet balance could not be read.'
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
                        onConfirmed={(receipt) => {
                          if (depositAmount !== undefined) setApproved({ hash: receipt.transactionHash, amount: depositAmount });
                          refresh();
                        }}
                      />
                      {allowanceUnread && (
                        <p className="text-detail" style={{ color: 'var(--color-state-unknown)' }}>
                          {ledger.isLoading
                            ? 'Your current approval is still loading, so approve the amount first.'
                            : 'Your current approval could not be read, so approve the amount first.'}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {approvedNow && (
                        <p className="text-detail" style={{ color: 'var(--color-state-ok)' }}>
                          Approved.{' '}
                          <a href={explorerTx(approved.hash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                            View the transaction
                          </a>
                          . Now move the funds in.
                        </p>
                      )}
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
                          setApproved(undefined);
                          refresh();
                        }}
                      />
                    </div>
                  )}
                </div>
              </Field>

              <Field label="Take funds out" hint="Withdraw any amount at any time. Payments already held in escrow are not included.">
                <div className="space-y-3">
                  <AmountInput
                    label="Amount"
                    asset="USDG"
                    value={withdrawText}
                    onChange={setWithdrawText}
                    max={{ atomic: balance, label: 'All of it' }}
                    {...(withdrawText.trim() === '' || withdraw.problem === undefined ? {} : { problem: withdraw.problem })}
                    hint={`This mandate holds ${usd(balance)}. It returns to your wallet.`}
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
