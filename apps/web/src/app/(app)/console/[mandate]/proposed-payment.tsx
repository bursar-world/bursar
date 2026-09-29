'use client';

import { useState } from 'react';
import type { Micro } from '@bursar/core';
import type { Address } from 'viem';

import { Button } from '@/components/button';
import { AmountInput } from '@/components/amount-input';
import { Card, Section } from '@/components/layout';
import { usd } from '@/money';
import { ChecksList, StatusRow } from '@/components/status';
import { AddressInput, readAddress } from '@/components/address-input';
import { readUsdgAmount } from '../lib/amount';
import { useCapabilityLabels } from '../lib/capability-labels';
import { useMandateScope } from './mandate-scope';

/**
 * Put a payment to the contract before making it.
 *
 * The permission state has nothing to answer until a payee and a kind of work are named, so this
 * is what names them. The account's own `previewSpend` runs in the same batched read as everything
 * else on the screen. The answer shown is the contract's, never this app's reading of the limits.
 */
export function ProposedPayment() {
  const { account, system, proposed, propose } = useMandateScope();
  const { remember } = useCapabilityLabels();
  const [payee, setPayee] = useState('');
  const [capability, setCapability] = useState('');
  const [amountText, setAmountText] = useState('');

  if (!account) return null;

  const payeeReading = readAddress(payee);
  const amountReading = readUsdgAmount(amountText);
  const asked = proposed.merchant !== undefined || proposed.capability !== undefined;

  // Anything typed has to be readable before the account is asked. A payee half typed and an
  // amount that is not one used to be dropped on the way to the contract, so the answer came back
  // about a narrower question than the one on the screen, and nothing said so.
  const named = payeeReading.value !== undefined || capability.trim() !== '';
  const unreadable = payeeReading.problem !== undefined || amountReading.problem !== undefined;
  const ready = named && !unreadable;

  const ask = () => {
    const next: { merchant?: Address; capability?: string; amount?: Micro } = {};
    if (payeeReading.value !== undefined) next.merchant = payeeReading.value;
    if (capability.trim() !== '') {
      next.capability = capability.trim();
      // The account is asked about this name by its hash, and the panel below reads hashes. A name
      // this screen has already resolved once is a name the gate table can show in place of bytes.
      remember(capability.trim());
    }
    if (amountReading.value !== undefined) next.amount = amountReading.value;
    propose(next);
  };

  const clear = () => {
    setPayee('');
    setCapability('');
    setAmountText('');
    propose({});
  };

  return (
    <Section
      title="Before you pay"
      description="Name a payment and the account answers what it would do with it. Nothing is signed and nothing is sent."
    >
      <Card>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            ask();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <AddressInput
              label="Pay to"
              value={payee}
              onChange={setPayee}
              hint="The provider that would receive the money."
            />
            <div className="space-y-1">
              <label
                htmlFor="proposed-capability"
                className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]"
              >
                For
              </label>
              <input
                id="proposed-capability"
                value={capability}
                placeholder="doc.summarize:1"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setCapability(event.target.value)}
                className="h-11 w-full border border-[color:var(--color-line)] bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
              />
              <p className="text-note text-[color:var(--color-muted)]">The kind of work being bought.</p>
            </div>
            <AmountInput
              label="Amount"
              asset="USDG"
              value={amountText}
              onChange={setAmountText}
              {...(amountReading.problem === undefined ? {} : { problem: amountReading.problem })}
              hint="Optional. With an amount the limits are checked too."
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!ready}>
              Ask the account
            </Button>
            {!ready && (
              <span className="text-detail text-[color:var(--color-muted)]">
                {unreadable
                  ? 'Correct the field marked above and the account can be asked.'
                  : 'Name a payee, a kind of work, or both.'}
              </span>
            )}
            {asked && (
              <Button tone="secondary" onClick={clear}>
                Clear
              </Button>
            )}
          </div>

          {asked && <Verdict />}

          {asked && (
            <div className="rounded-md border border-[color:var(--color-line)] px-4">
              <StatusRow state={system.permission} onRetry={system.refresh}>
                <ChecksList checks={system.permission.checks} />
              </StatusRow>
              <StatusRow state={system.mandate} onRetry={system.refresh} />
            </div>
          )}
        </form>
      </Card>
    </Section>
  );
}

/**
 * The answer in one line, over the rows that explain it. The rows name each condition on its own;
 * this says what they add up to for the payment on the screen, funds included, since the contract's
 * preview checks the limits and not the balance.
 */
function Verdict() {
  const { system, proposed } = useMandateScope();
  const amount = proposed.amount;
  const held = system.funding.facts.mandateBalance;
  const levels = [system.permission.level, system.mandate.level];
  if (levels.includes('unknown')) return null;

  const short = amount !== undefined && held !== undefined && held < amount;
  const blocked = levels.includes('blocked');
  const waits = !blocked && system.mandate.level === 'attention' && /signature|approv/i.test(system.mandate.headline);
  const subject = amount === undefined ? 'A payment like this' : `A payment of ${usd(amount)}`;

  const line = blocked
    ? `${subject} would be refused. The reason is below.`
    : waits
      ? `${subject} would wait for your approval before it settles.`
      : `${subject} would go through within the limits.`;

  return (
    <div className="space-y-1" role="status">
      <p className="text-sm font-medium">{line}</p>
      {short && !blocked && (
        <p className="text-detail text-[color:var(--color-state-attention)]">
          The mandate holds {usd(held!)}, less than this payment, so it would fail on funds unless the account can draw the
          difference in the same transaction.
        </p>
      )}
    </div>
  );
}
