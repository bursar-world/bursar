'use client';

import Link from 'next/link';

import { adminTimelockAbi, sameAddress } from '@/chain';
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
import type { Governance, Proposal, ProposalStatus, TimelockReading } from './read';
import { governanceNotice, permits } from './roles';
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
 * Governance: two signatures and a fixed delay, on each of the two delay contracts.
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

  return (
    <div className="space-y-10">
      <Section
        title="Governance"
        description="Every setting that decides what a mandate can do changes only with two of three signatures and a fixed delay."
        actions={
          <Button size="sm" onClick={governance.refresh} disabled={governance.isFetching}>
            {governance.isFetching ? 'Reading' : 'Read again'}
          </Button>
        }
      >
        <Card>
          <div className="max-w-3xl space-y-3 text-sm">
            <p>
              A change needs two of the three signers. The delay before it takes effect gives anyone relying on Bursar
              time to read it and leave. Any one signer can cancel a proposal before it runs, so blocking a change is
              easier than making one.
            </p>
            <p>
              Each governance delay is a timelock: a contract that holds an approved change until its wait is over. More
              than one is live, one for each set of payment contracts on this chain, and the token, staking and the
              buyback answer to one of them. Each delay is listed below with what it administers, and every proposal
              says which delay governs it.
            </p>
            <p>
              The pause is the one exception. The guardian key can pause an administered contract at once, with no
              approvals and no wait, and it can do nothing else.
            </p>
          </div>

          {data === undefined ? (
            <p className="mt-5 text-sm text-[color:var(--color-muted)]">Reading the governance contracts.</p>
          ) : (
            data.timelocks.map((reading) => <TimelockFacts key={reading.tag.address} reading={reading} />)
          )}
        </Card>

        <ConnectedAs roles={roles} />

        {data && !data.complete && (
          <Unread onRetry={governance.refresh}>
            Part of this page could not be read right now. A field marked Not read says nothing about whether a
            proposal is pending.
          </Unread>
        )}

        <ErrorSurface error={governance.error} action="Reading governance" onRetry={governance.refresh} />
      </Section>

      <Section
        title="Proposals"
        description={
          data?.blockNumber === undefined
            ? 'Newest first.'
            : `Newest first, from both governance delays, as of block ${data.blockNumber.toString()}. Countdowns use chain time.`
        }
      >
        {data === undefined ? (
          <Card>
            <p className="text-sm text-[color:var(--color-muted)]">Reading the governance contract.</p>
          </Card>
        ) : !data.complete ? (
          <EmptyState title="Proposals could not be read.">Read again to see whether anything is pending.</EmptyState>
        ) : data.proposals.length === 0 ? (
          <EmptyState title="Nothing is pending.">
            A change appears here as soon as a signer proposes it, and waits the full delay before it can run.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {data.proposals.map((proposal) => (
              <ProposalCard
                key={`${proposal.timelock.address}-${proposal.id}`}
                proposal={proposal}
                canSign={permits(roles.signer) && signsFor(data.timelocks, proposal, roles.address)}
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
        delaySeconds={data?.delaySeconds}
        escrowDelaySeconds={escrowBrakeDelay(data)}
        blockedBy={blockedBy}
        onPaused={governance.refresh}
      />

      <Card title="Fees and the treasury are elsewhere">
        <p className="max-w-3xl text-sm">
          Sweeping settlement fees and changing the escrow treasury are not proposals, because the escrow has no admin
          role. They are on the{' '}
          <Link href="/ops" className="underline underline-offset-2">
            Operations page
          </Link>
          , which also drafts staking and buyback proposals with this same form.
        </p>
      </Card>
    </div>
  );
}

/** The timelock's own signer set decides, and an unread set leaves the control offered. */
/** The delay of whichever timelock the escrow lets pause it, which is the one its restart goes through. */
function escrowBrakeDelay(data: Governance | undefined): bigint | undefined {
  const escrow = data?.brake.find((target) => target.key === 'escrow');
  if (escrow?.admin === undefined) return undefined;
  return data?.timelocks.find((reading) => sameAddress(reading.tag.address, escrow.admin))?.delaySeconds;
}

function signsFor(timelocks: readonly TimelockReading[], proposal: Proposal, address: string | undefined): boolean {
  const signers = timelocks.find((reading) => sameAddress(reading.tag.address, proposal.timelock.address))?.signers;
  return signers === undefined || signers.some((signer) => sameAddress(signer, address));
}

function TimelockFacts({ reading }: { readonly reading: TimelockReading }) {
  return (
    <div className="mt-5">
      <p className="mb-2 text-sm font-medium">{reading.tag.name}</p>
      <FieldGrid columns={4}>
        <Field label="Delay" hint="Fixed for the life of the contract. Nothing can change it.">
          {reading.delaySeconds === undefined ? NOT_READ : formatDuration(Number(reading.delaySeconds))}
        </Field>
        <Field label="Approvals needed" hint="Proposing counts as the proposer's approval.">
          {reading.requiredApprovals === undefined || reading.signerCount === undefined
            ? NOT_READ
            : `${reading.requiredApprovals} of ${reading.signerCount}`}
        </Field>
        <Field label="Window to execute" hint="Opens after the delay. A proposal not executed in time must be proposed again.">
          {reading.graceSeconds === undefined ? NOT_READ : formatDuration(Number(reading.graceSeconds))}
        </Field>
        <Field label="Governance contract">
          <Address value={reading.tag.address} />
        </Field>
      </FieldGrid>
      <div className="mt-3">
        <FieldGrid columns={2}>
          <Field label="Signers" hint="Only current signers' approvals count, so a replaced key's approvals stop counting.">
            <div className="space-y-1">
              {reading.signers === undefined ? NOT_READ : reading.signers.map((signer) => <Address key={signer} value={signer} />)}
            </div>
          </Field>
          <Field label="Guardian" hint="Can pause and nothing else. It can never be a signer.">
            {reading.guardian === undefined ? NOT_READ : <Address value={reading.guardian} />}
          </Field>
        </FieldGrid>
      </div>
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
            <span className="text-[color:var(--color-muted)]">The guardian is a separate key and can do none of these.</span>
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
      address: proposal.timelock.address,
      abi: adminTimelockAbi,
      functionName,
      args: [BigInt(proposal.id)],
    });

  return (
    <Card
      title={`Proposal ${proposal.id}`}
      description={`${call.sentence} Governed by the delay for ${proposal.timelock.name.toLowerCase()}.`}
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
          hint={proposal.status === 'waiting-out-the-delay' ? 'Nothing can make this run sooner.' : undefined}
        >
          {proposal.status === 'waiting-out-the-delay' ? (
            <Countdown to={proposal.executeAfter} />
          ) : (
            <Instant at={proposal.executeAfter} />
          )}
        </Field>
        <Field label={proposal.status === 'expired' ? 'Expired' : 'Expires'} hint="If not executed by then, it must be proposed again.">
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
          It cannot be executed right now: {proposal.refusal}.
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
            confirmDescription={`${call.sentence} A cancelled proposal cannot be restored. To make the same change, propose it again and wait the full delay.`}
            blockedBy={blockedBy}
            send={send('cancel')}
            onContinue={onChanged}
          />
        </div>
      )}

      {!canSign && open && (
        <p className="mt-5 text-detail text-[color:var(--color-muted)]">
          Approving, executing and cancelling need one of the three signer keys for this proposal&rsquo;s delay.
        </p>
      )}
    </Card>
  );
}
