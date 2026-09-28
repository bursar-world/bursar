'use client';

import Link from 'next/link';

import { ADDRESSES, adminTimelockAbi, sameAddress } from '@/chain';
import { readCall } from '@/chain/admin-actions';
import { Address } from '@/components/address';
import { Badge, LevelDot } from '@/components/badge';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Countdown, Instant } from '@/components/instant';
import { Card, EmptyState, Field, FieldGrid, Section } from '@/components/layout';
import { Unread } from '@/components/status';
import { TxButton } from '@/components/tx-button';
import { formatDuration } from '@/lib';
import { useSystemState } from '@/state';
import type { AnyState } from '@/state';
import { useWalletAccount } from '@/wallet/account';

import { GuardianPanel, ProposePanel } from './actions-panel';
import type { Proposal, ProposalStatus } from './read';
import { CUSTODY_LINE, governanceNotice, permits } from './roles';
import type { Roles } from './roles';
import { useGovernance } from './use-governance';
import { useWriteContract } from '@/wallet/write';

const STATUS_WORD: Readonly<Record<ProposalStatus, string>> = {
  'awaiting-approvals': 'Waiting on approvals',
  'waiting-out-the-delay': 'Waiting out the delay',
  executable: 'Ready to execute',
  executed: 'Executed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  'not-read': 'Not read',
};

const NOT_READ = <span className="text-[color:var(--color-muted)]">Not read</span>;

/**
 * Governance, which on this deployment is two signatures and two days.
 *
 * The page is built around the thing a reader needs from it: what is pending, what each
 * pending change would do in words, who has signed it, and when it can land. A signer can do all
 * four things from here. The delay is explained once, at the top, because a reader who does not
 * understand why the brake is exempt from it will read the guardian as a back door.
 */
export function GovernanceView() {
  const governance = useGovernance();
  const system = useSystemState();
  const blockedBy = [system.connectivity, system.asset];
  const data = governance.data;
  const roles = governance.roles;
  // Before the first reading lands every field is still on its way. After it lands, a field with
  // nothing in it is a call the timelock did not answer, and the two must not share a word.
  const unread = data === undefined ? 'Reading' : NOT_READ;

  return (
    <div className="space-y-10">
      <Section
        title="Governance"
        description="Every parameter that decides what a mandate can do sits behind two of three signatures and a fixed delay."
        actions={
          <Button size="sm" onClick={governance.refresh} disabled={governance.isFetching}>
            {governance.isFetching ? 'Reading' : 'Read again'}
          </Button>
        }
      >
        <Card>
          <div className="max-w-3xl space-y-3 text-sm">
            <p>
              Two signers agreeing is what authorises a change. The wait between that and the change taking effect is
              what gives anyone relying on the system time to read it and leave. Any single signer can cancel a proposal
              before it lands, because blocking a change should cost less than making one.
            </p>
            <p>
              The pause is the exception, and it has to be. A brake that takes two days is not a brake, so the guardian
              key can stop an administered contract in the same block with no approvals and no wait. It can do nothing
              else: the call it sends is built inside the timelock and is always <code>pause()</code>. Restarting is a
              proposal like any other. That is what makes a stolen guardian key an outage rather than a loss.
            </p>
            <p className="text-[color:var(--color-muted)]">{CUSTODY_LINE}</p>
          </div>

          <div className="mt-5">
            <FieldGrid columns={4}>
              <Field label="Delay" hint="Fixed at deployment. There is no setter for it.">
                {data?.delaySeconds === undefined ? unread : formatDuration(Number(data.delaySeconds))}
              </Field>
              <Field label="Approvals needed" hint="Proposing counts as the proposer's approval.">
                {data?.requiredApprovals === undefined || data.signerCount === undefined
                  ? unread
                  : `${data.requiredApprovals} of ${data.signerCount}`}
              </Field>
              <Field label="Window to execute" hint="After the delay. A proposal left past this has to be made again.">
                {data?.graceSeconds === undefined ? unread : formatDuration(Number(data.graceSeconds))}
              </Field>
              <Field label="Governance contract">
                <Address value={ADDRESSES.adminTimelock} />
              </Field>
            </FieldGrid>
          </div>

          <div className="mt-5">
            <FieldGrid columns={2}>
              <Field label="Signers" hint="Approvals are counted over this set, so a rotated key stops carrying what it approved.">
                <div className="space-y-1">
                  {data?.signers === undefined ? unread : data.signers.map((signer) => <Address key={signer} value={signer} />)}
                </div>
              </Field>
              <Field label="Guardian" hint="Holds the pause and nothing else, and is barred from the signer set.">
                {data?.guardian === undefined ? unread : <Address value={data.guardian} />}
              </Field>
            </FieldGrid>
          </div>
        </Card>

        <ConnectedAs roles={roles} />

        {data && !data.complete && (
          <Unread onRetry={governance.refresh}>
            The timelock did not answer this reading. A field below that shows as not read tells you nothing about
            whether a proposal is pending. Nothing has changed on chain; only the reading failed.
          </Unread>
        )}

        <ErrorSurface error={governance.error} action="reading governance" onRetry={governance.refresh} />
      </Section>

      <Section
        title="Proposals"
        description={
          data?.blockNumber === undefined
            ? 'Newest first. Read from the contract.'
            : `Newest first, so the top card is the highest id. Read at block ${data.blockNumber.toString()}. Countdowns run against the chain's clock.`
        }
      >
        {data === undefined ? (
          <Card>
            <p className="text-sm text-[color:var(--color-muted)]">Reading the governance contract.</p>
          </Card>
        ) : !data.complete ? (
          <EmptyState title="This list was not read.">
            The timelock did not answer how many proposals it holds, so whether anything is pending is unknown. Nothing
            has changed on chain; only the reading failed.
          </EmptyState>
        ) : data.proposals.length === 0 ? (
          <EmptyState title="Nothing is pending.">
            A change to any governed parameter shows up here the moment a signer proposes it, and sits for the full
            delay before it can execute.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {data.proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                canSign={permits(roles.signer)}
                blockedBy={blockedBy}
                onChanged={governance.refresh}
              />
            ))}
          </div>
        )}
      </Section>

      <ProposePanel
        canPropose={roles.signer}
        delaySeconds={data?.delaySeconds}
        blockedBy={blockedBy}
        onProposed={governance.refresh}
      />

      <GuardianPanel
        canPause={roles.guardian}
        targets={data?.brake ?? []}
        timelock={ADDRESSES.adminTimelock}
        delaySeconds={data?.delaySeconds}
        blockedBy={blockedBy}
        onPaused={governance.refresh}
      />

      <Card title="Fees and the treasury are elsewhere">
        <p className="max-w-3xl text-sm">
          Sweeping escrow fees and rotating the escrow treasury are not timelock calls, because the escrow has no admin
          role. They live on the{' '}
          <Link href="/ops" className="underline underline-offset-2">
            operator surface
          </Link>
          , which also builds the staking and buyback proposals through this same form.
        </p>
      </Card>
    </div>
  );
}

/** What the connected wallet may do here, or why it may do nothing. */
function ConnectedAs({ roles }: { readonly roles: Roles }) {
  const notice = governanceNotice(roles);
  if (!notice) {
    return (
      <Card>
        <p className="flex items-start gap-2 text-sm">
          <span className="pt-1">
            <LevelDot level="ok" />
          </span>
          <span>
            This wallet is one of the three signers. It can propose, approve, cancel and execute from this page.{' '}
            <span className="text-[color:var(--color-muted)]">The guardian key is a separate one and cannot do any of those.</span>
          </span>
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <p className="flex items-start gap-2 text-sm">
        <span className="pt-1">
          <LevelDot level={roles.address === undefined ? 'unknown' : roles.signer === 'unread' ? 'unknown' : 'attention'} />
        </span>
        <span>
          {notice.headline} <span className="text-[color:var(--color-muted)]">{notice.detail}</span>
        </span>
      </p>
    </Card>
  );
}

function ProposalCard({
  proposal,
  canSign,
  blockedBy,
  onChanged,
}: {
  readonly proposal: Proposal;
  readonly canSign: boolean;
  readonly blockedBy: readonly AnyState[];
  readonly onChanged: () => void;
}) {
  const { address } = useWalletAccount();
  const { writeContractAsync } = useWriteContract();
  const call = readCall(proposal.target, proposal.data);
  const open = !proposal.executed && !proposal.cancelled && proposal.status !== 'expired';
  // With the signature list unread, the approval is still offered. The contract refuses a second
  // one from the same signer, so asking costs at most a reverted simulation. Hiding the control
  // would put a wrong reading of who has signed on the screen instead.
  const alreadyApproved = proposal.approvedBy?.some((signer) => sameAddress(signer, address)) ?? false;

  const send = (functionName: 'approve' | 'execute' | 'cancel') => () =>
    writeContractAsync({
      address: ADDRESSES.adminTimelock,
      abi: adminTimelockAbi,
      functionName,
      args: [BigInt(proposal.id)],
    });

  return (
    <Card
      title={`Proposal ${proposal.id}`}
      description={call.sentence}
      actions={<Badge tone={open ? 'neutral' : 'quiet'}>{STATUS_WORD[proposal.status]}</Badge>}
    >
      <FieldGrid columns={4}>
        <Field label="Approvals">
          {proposal.approvals === undefined ? NOT_READ : <span className="tabular">{proposal.approvals}</span>}
        </Field>
        <Field label="Proposed">
          <Instant at={proposal.createdAt} />
        </Field>
        <Field
          label={proposal.status === 'waiting-out-the-delay' ? 'Executable in' : 'Executable from'}
          hint={proposal.status === 'waiting-out-the-delay' ? 'Nothing can make this land sooner.' : undefined}
        >
          {proposal.status === 'waiting-out-the-delay' ? (
            <Countdown to={proposal.executeAfter} />
          ) : (
            <Instant at={proposal.executeAfter} />
          )}
        </Field>
        <Field label={proposal.status === 'expired' ? 'Expired' : 'Expires'} hint="Unexecuted past this, it has to be proposed again.">
          {proposal.expiresAt === undefined ? (
            NOT_READ
          ) : proposal.status === 'executable' ? (
            <Countdown to={proposal.expiresAt} />
          ) : (
            <Instant at={proposal.expiresAt} />
          )}
        </Field>
      </FieldGrid>

      <div className="mt-5">
        <FieldGrid columns={2}>
          <Field label="Target">
            <Address value={proposal.target} label={call.targetName} />
          </Field>
          <Field label="Approved by">
            <div className="space-y-1">
              {proposal.approvedBy === undefined
                ? NOT_READ
                : proposal.approvedBy.length === 0
                ? 'Nobody yet'
                : proposal.approvedBy.map((signer) => <Address key={signer} value={signer} />)}
            </div>
          </Field>
        </FieldGrid>
      </div>

      {call.rows.length > 0 && (
        <div className="mt-5">
          <Field label="What it passes">
            <ul className="space-y-1">
              {call.rows.map((argument) => (
                <li key={`${argument.label}-${argument.value}`} className="text-sm">
                  <span className="text-[color:var(--color-muted)]">{argument.label}</span>{' '}
                  {argument.address ? (
                    <Address value={argument.address} />
                  ) : (
                    <span className="tabular">{argument.value}</span>
                  )}
                </li>
              ))}
            </ul>
          </Field>
        </div>
      )}

      <details className="mt-5">
        <summary className="text-detail text-[color:var(--color-muted)]">Calldata</summary>
        <p className="mt-2 break-all font-mono text-note">{proposal.data}</p>
        {call.signature && <p className="mt-1 text-note text-[color:var(--color-muted)]">{call.signature}</p>}
      </details>

      {proposal.refusal && open && (
        <p className="mt-4 text-detail text-[color:var(--color-muted)]">
          Executing it right now would be refused with {proposal.refusal}.
        </p>
      )}

      {/*
        Every label names the proposal it acts on. The list runs newest first, so the topmost
        Execute is the highest id and not proposal 0, and a signer reaching for a particular
        proposal read the card title, moved their eye down to a button reading "Execute" and
        executed a different one. The id travels with the control.

        The three of them hold their confirmed state and re-read behind "Read it again", because
        executing, approving or cancelling all take this action row off the screen the instant the
        new state lands, and with it the only evidence the transaction was mined.
      */}
      {canSign && open && (
        <div className="mt-5 flex flex-wrap items-start gap-3">
          {!alreadyApproved && (
            <TxButton label={`Approve proposal ${proposal.id}`} blockedBy={blockedBy} send={send('approve')} onContinue={onChanged} />
          )}
          {proposal.status === 'executable' && (
            <TxButton label={`Execute proposal ${proposal.id}`} blockedBy={blockedBy} send={send('execute')} onContinue={onChanged} />
          )}
          <TxButton
            label={`Cancel proposal ${proposal.id}`}
            tone="destructive"
            confirmPhrase="CANCEL"
            confirmTitle={`Cancel proposal ${proposal.id}`}
            confirmDescription={`${call.sentence} A cancelled proposal cannot be revived. Making the same change again means proposing it again and waiting out the full delay.`}
            blockedBy={blockedBy}
            send={send('cancel')}
            onContinue={onChanged}
          />
        </div>
      )}

      {!canSign && open && (
        <p className="mt-5 text-detail text-[color:var(--color-muted)]">
          Approving, executing and cancelling need one of the three signer keys.
        </p>
      )}
    </Card>
  );
}
