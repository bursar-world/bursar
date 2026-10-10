import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';
import { formatUnits } from 'viem';

import { explorerTx } from '@/chain/rhc';
import { Button } from '@/components/button';
import { SelectField, TextField } from '@/components/fields';
import { Field, FieldGrid } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { spellDuration } from '@/lib/time';
import { usd, usdHeld } from '@/money';
import type { FundingQuote, RelayStatus, SourceChain, SourceKey } from '@/relay';
import { depositSeen } from '@/relay';

/**
 * Funding a mandate from Base, Arc or Solana, as the reader sees it.
 *
 * Relay carries the transfer: USDC leaves the reader's wallet on the chain they chose and USDG
 * arrives in the mandate on Robinhood Chain, paid by Relay from its own balance here. Nothing
 * passes through this console. The screen says what leaves, what arrives, what Relay charges and
 * how long it takes, and then follows the transfer until the USDG is in the account.
 *
 * Rendered from a phase and nothing else, so each face can be looked at on its own.
 */
export type Carried = {
  readonly requestId: Hex;
  readonly sourceKey: SourceKey;
  /** Atomic units of the source chain's USDC, where known. A resumed request may not know. */
  readonly sends: bigint | undefined;
  readonly expected: Micro | undefined;
  readonly depositHash: string | undefined;
};

export type FundingPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'quoting' }
  | { readonly kind: 'quoted'; readonly quote: FundingQuote; readonly note?: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'signing'; readonly quote: FundingQuote; readonly step: string }
  | { readonly kind: 'awaiting'; readonly carried: Carried; readonly status: RelayStatus | undefined }
  | { readonly kind: 'arrived'; readonly carried: Carried; readonly fillHash: string | undefined; readonly landed: Micro | undefined }
  | { readonly kind: 'failed'; readonly carried: Carried | undefined; readonly reason: string; readonly refundHash: string | undefined };

export type FundFromChainViewProps = {
  readonly sources: readonly SourceChain[];
  readonly source: SourceChain;
  readonly recipient: Address;
  readonly amountText: string;
  readonly amountProblem: string | undefined;
  readonly phase: FundingPhase;
  /** A wallet is connected, so the deposit can be signed here. */
  readonly connected: boolean;
  /** USDC the wallet holds on the source chain, once read. */
  readonly sourceBalance: bigint | undefined;
  /** The wallet holds nothing for the network fee on the source chain. */
  readonly noGas: boolean;
  /** Relay's own page with the route filled in, for a chain this console has no wallet for. */
  readonly relayLink: string;
  readonly onSource: (key: SourceKey) => void;
  readonly onAmount: (text: string) => void;
  readonly onFund: () => void;
  readonly onReset: () => void;
};

export function FundFromChainView(props: FundFromChainViewProps) {
  const { source, phase } = props;
  const inFlight = phase.kind === 'signing' || phase.kind === 'awaiting';
  const settled = phase.kind === 'arrived' || phase.kind === 'failed';

  return (
    <div className="space-y-5 border-t border-[color:var(--color-line)] pt-5">
      <div>
        <h3 className="text-sm font-medium">Fund from another chain</h3>
        <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
          Send USDC from Base, Arc or Solana. Relay carries it and USDG lands in this mandate, usually within a minute.
        </p>
      </div>

      {!settled && (
        <FieldGrid columns={2}>
          <SelectField
            label="From"
            value={source.key}
            options={props.sources.map((chain) => ({ value: chain.key, label: `USDC on ${chain.name}` }))}
            onChange={(key) => props.onSource(key as SourceKey)}
            disabled={inFlight}
            help={source.vm === 'evm' ? 'Signed in your connected wallet.' : 'Signed in your Solana wallet, on Relay.'}
          />
          <TextField
            label="Amount"
            value={props.amountText}
            onChange={props.onAmount}
            suffix="USDC"
            placeholder="0.00"
            disabled={inFlight}
            {...(props.amountProblem === undefined ? {} : { problem: props.amountProblem })}
            help={balanceLine(props)}
          />
        </FieldGrid>
      )}

      {phase.kind === 'quoting' && (
        <p className="text-detail text-[color:var(--color-muted)]" aria-busy="true">
          Asking Relay for a quote.
        </p>
      )}

      {phase.kind === 'refused' && (
        <p role="alert" className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
          {phase.reason}
        </p>
      )}

      {(phase.kind === 'quoted' || phase.kind === 'signing') && <QuoteFace quote={phase.quote} source={source} />}

      {phase.kind === 'quoted' && phase.note !== undefined && (
        <p className="text-detail text-[color:var(--color-muted)]">{phase.note}</p>
      )}

      {(phase.kind === 'quoted' || phase.kind === 'signing') && source.vm === 'evm' && (
        <div className="space-y-2">
          <Button tone="primary" disabled={phase.kind === 'signing' || !props.connected || props.noGas} onClick={props.onFund}>
            {phase.kind === 'signing' ? signingLabel(phase.step, source) : `Fund from ${source.name}`}
          </Button>
          {!props.connected && <p className="text-detail text-[color:var(--color-muted)]">Connect a wallet that holds USDC on {source.name} to sign the deposit.</p>}
          {props.connected && props.noGas && (
            <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
              Your wallet holds no {source.wagmi?.nativeCurrency.symbol ?? 'gas'} on {source.name} for the network fee, so the deposit cannot be sent.
            </p>
          )}
          {phase.kind === 'signing' && (
            <p className="text-detail text-[color:var(--color-muted)]">
              {phase.quote.steps.length > 1 ? 'Two signatures: one approves the USDC, one deposits it with Relay.' : 'One signature deposits the USDC with Relay.'}
            </p>
          )}
        </div>
      )}

      {phase.kind === 'quoted' && source.vm === 'svm' && (
        <SolanaFace quote={phase.quote} link={props.relayLink} onWatch={props.onFund} />
      )}

      {phase.kind === 'awaiting' && <AwaitingFace carried={phase.carried} status={phase.status} source={source} />}

      {phase.kind === 'arrived' && <ArrivedFace carried={phase.carried} fillHash={phase.fillHash} landed={phase.landed} source={source} onReset={props.onReset} />}

      {phase.kind === 'failed' && (
        <div className="space-y-3">
          <p role="alert" className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
            {phase.reason}
          </p>
          <Links carried={phase.carried} source={source} refundHash={phase.refundHash} />
          <Button tone="secondary" onClick={props.onReset}>
            Start over
          </Button>
        </div>
      )}
    </div>
  );
}

function balanceLine(props: FundFromChainViewProps): string {
  if (props.source.vm === 'svm') return 'Any amount of USDC. Relay charges a small fee on top of the network fee.';
  if (!props.connected) return `USDC on ${props.source.name}, from the wallet you connect.`;
  if (props.sourceBalance === undefined) return `Your USDC balance on ${props.source.name} has not been read yet.`;
  return `Your wallet holds ${formatSource(props.sourceBalance, props.source)} on ${props.source.name}.`;
}

function signingLabel(step: string, source: SourceChain): string {
  if (step === 'switch') return `Switching your wallet to ${source.name}`;
  if (step === 'approve') return 'Approve the USDC in your wallet';
  return 'Confirm the deposit in your wallet';
}

/** What leaves, what arrives, what it costs, how long. The decision, on one row. */
function QuoteFace({ quote, source }: { readonly quote: FundingQuote; readonly source: SourceChain }) {
  return (
    <StatGrid columns={4}>
      <Stat label="You send" value={formatSource(quote.source.amount, source)} hint={`USDC on ${source.name}.`} />
      <Stat
        label="The mandate receives"
        value={usdHeld(quote.arrives.expected)}
        hint={quote.arrives.minimum < quote.arrives.expected ? `USDG. At least ${usdHeld(quote.arrives.minimum)} if the price moves.` : 'USDG, on Robinhood Chain.'}
        level="ok"
      />
      <Stat label="It costs" value={usd(quote.fees.total)} hint={costLine(quote, source)} />
      <Stat label="It takes" value={arrivalTime(quote.seconds)} hint="Relay pays the mandate from its own USDG once your deposit is confirmed." numeric={false} />
    </StatGrid>
  );
}

function costLine(quote: FundingQuote, source: SourceChain): string {
  if (quote.fees.gas === 0n) return "Relay's fee, taken from what you send.";
  return `Relay's fee of ${usd(quote.fees.relay)} plus about ${usd(quote.fees.gas)} in network fees on ${source.name}.`;
}

function arrivalTime(seconds: number): string {
  if (seconds <= 10) return 'Seconds';
  if (seconds < 60) return `About ${seconds} seconds`;
  return `About ${spellDuration(seconds)}`;
}

function SolanaFace({ quote, link, onWatch }: { readonly quote: FundingQuote; readonly link: string; readonly onWatch: () => void }) {
  if (quote.depositAddress !== undefined) {
    return (
      <div className="space-y-3">
        <QuoteFace quote={quote} source={SOLANA_FACE} />
        <Field label="Send the USDC to this Solana address" hint="Send exactly the amount quoted, from any Solana wallet or exchange. Relay pays the mandate when it lands.">
          <span className="tabular break-all">{quote.depositAddress}</span>
        </Field>
        <Button tone="primary" onClick={onWatch}>
          I have sent it
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <QuoteFace quote={quote} source={SOLANA_FACE} />
      <p className="text-detail text-[color:var(--color-muted)]">
        This console has no Solana wallet. Relay's own page has the route filled in with this mandate as the recipient; sign there and the USDG
        lands here.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <a href={link} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center border border-[color:var(--color-line)] px-4 text-sm font-medium underline-offset-2 hover:underline">
          Open the route on Relay
        </a>
        <Button tone="secondary" onClick={onWatch}>
          Watch for it here
        </Button>
      </div>
    </div>
  );
}

/** Solana as the quote face names it; the chain record is passed where one exists. */
const SOLANA_FACE: SourceChain = {
  key: 'solana',
  chainId: 792703809,
  name: 'Solana',
  vm: 'svm',
  usdc: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
  explorerTx: (signature) => `https://solscan.io/tx/${signature}`,
  wagmi: undefined,
};

function AwaitingFace({ carried, status, source }: { readonly carried: Carried; readonly status: RelayStatus | undefined; readonly source: SourceChain }) {
  const seen = status !== undefined && depositSeen(status);
  const line = seen
    ? `Relay has your deposit and is paying the mandate on Robinhood Chain.`
    : carried.depositHash === undefined
      ? `Waiting for your USDC to reach Relay on ${source.name}. This updates on its own.`
      : `Your deposit is on ${source.name}. Waiting for Relay to confirm it.`;

  return (
    <div className="space-y-3" aria-live="polite" aria-busy="true">
      <StatGrid columns={2}>
        <Stat label="Status" value={seen ? 'Relay is paying the mandate' : 'Waiting for the deposit'} level="attention" numeric={false} hint={line} />
        <Stat
          label="Arriving"
          value={carried.expected === undefined ? 'USDG' : usdHeld(carried.expected)}
          hint={carried.sends === undefined ? 'What Relay quoted.' : `For ${formatSource(carried.sends, source)} sent from ${source.name}.`}
        />
      </StatGrid>
      {status?.phase === 'delayed' && (
        <p className="text-detail text-[color:var(--color-muted)]">Relay reports a delay on its side. Your deposit is held by Relay and this keeps checking.</p>
      )}
      <Links carried={carried} source={source} refundHash={undefined} />
    </div>
  );
}

function ArrivedFace({
  carried,
  fillHash,
  landed,
  source,
  onReset,
}: {
  readonly carried: Carried;
  readonly fillHash: string | undefined;
  readonly landed: Micro | undefined;
  readonly source: SourceChain;
  readonly onReset: () => void;
}) {
  const amount = landed ?? carried.expected;
  return (
    <div className="space-y-3" aria-live="polite">
      <StatGrid columns={2}>
        <Stat label="Arrived" value={amount === undefined ? 'USDG landed' : usdHeld(amount)} level="ok" hint="USDG is in the mandate and pays providers from now." />
        <Stat label="Carried by" value="Relay" numeric={false} hint={carried.sends === undefined ? `From ${source.name}.` : `${formatSource(carried.sends, source)} sent from ${source.name}.`} />
      </StatGrid>
      <Links carried={carried} source={source} refundHash={undefined} fillHash={fillHash} />
      <Button tone="secondary" onClick={onReset}>
        Fund again
      </Button>
    </div>
  );
}

function Links({ carried, source, refundHash, fillHash }: { readonly carried: Carried | undefined; readonly source: SourceChain; readonly refundHash: string | undefined; readonly fillHash?: string }) {
  if (carried === undefined) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-detail">
      {carried.depositHash !== undefined && (
        <li>
          <a href={source.explorerTx(carried.depositHash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            Your deposit on {source.name}
          </a>
        </li>
      )}
      {fillHash !== undefined && (
        <li>
          <a href={explorerTx(fillHash as Hex)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            The USDG landing on Robinhood Chain
          </a>
        </li>
      )}
      {refundHash !== undefined && (
        <li>
          <a href={source.explorerTx(refundHash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            The refund on {source.name}
          </a>
        </li>
      )}
      <li>
        <a href={`https://relay.link/transaction/${carried.requestId}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          This transfer on Relay
        </a>
      </li>
    </ul>
  );
}

/** "0.50 USDC": at least two places, at most six, no trailing zeros beyond two. */
export function formatSource(amount: bigint, source: SourceChain): string {
  const text = formatUnits(amount, source.usdc.decimals);
  const [whole = '0', fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const places = trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed;
  return `${whole}.${places} ${source.usdc.symbol}`;
}
