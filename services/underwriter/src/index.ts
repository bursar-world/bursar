export {
  BodyTooLargeError,
  ChainUnavailableError,
  DocumentError,
  JournalHeldError,
  LogError,
  RequestError,
  RequestReplayedError,
  UnderwriterConfigError,
} from './errors.js';
export type { LogErrorCode } from './errors.js';

export { canonicalJson, sha256Bytes32, sha256Hex } from './canonical.js';
export type { CanonicalValue } from './canonical.js';

export { RefuseReason, allow, bucketFor, hold, refuse } from './decision.js';
export type { AllowDecision, Bucket, Decision, HoldDecision, RefuseDecision } from './decision.js';

export { parseRule, permits, ruleToPattern } from './rules.js';
export type { Rule, RuleEffect, RulePattern } from './rules.js';

export { MAX_AMOUNT_MICROS, documentHash, documentPreimage, parseDocument, parseTimestamp } from './document.js';
export type { Address, Hex32, MandateDocument, MandateWindow, MerchantGate } from './document.js';

export { merchantLeaf, processProof, verifyMerchantProof } from './merkle.js';

export { GENESIS_PREV_HASH, SpendLog, decodeEntry, encodeEntry, hashEntry } from './log.js';
export type {
  DecisionBody,
  LogBody,
  LogEntry,
  LoggedRequest,
  RefundBody,
  RefundOrigin,
  ReplayOptions,
  Resolution,
  SettlementBody,
  TransportEntry,
  VerifyResult,
} from './log.js';

export { FileDecisionSink, headMarkerPath, loadJournal, nullSink, readHead, verifyJournalFile } from './journal.js';
export type { DecisionSink, JournalHead } from './journal.js';

export {
  assertClock,
  assertRequest,
  authorizeAgainstDocument,
  documentWindows,
  evaluateDocument,
  windowStartMs,
} from './policy.js';
export type { DocumentAuthorization, DocumentWindows, SpendRequest, WindowState } from './policy.js';

export {
  ACCOUNT_SELECTORS,
  APPROVAL_REQUIRED_SELECTOR,
  ESCROW_SELECTORS,
  MERKLE_GATE_ACTIVE_SELECTOR,
  ZERO_SELECTOR,
  accountRefusal,
  errorSelector,
  isApprovalRequired,
  isMerkleGateActive,
  spendRefusal,
} from './selectors.js';
export type { ChainRefusal, Selector } from './selectors.js';

export { FACET_NOT_FOUND, controlFailure, createMandateChain, revertSelector } from './chain.js';
export type {
  AccountState,
  BlockRef,
  ChainLimits,
  ChainMerchantGate,
  ChainWindow,
  ControlReading,
  EscrowTerms,
  IssuerControls,
  MandateChain,
  MerchantStanding,
  PartyControl,
  PreviewResult,
  SimulationResult,
  SpendCall,
} from './chain.js';

export { assetCondition } from './asset.js';
export type { AssetCondition, SpendParties } from './asset.js';

export { checkDeadline, deadlineBounds, escrowPreflight } from './escrow.js';
export type { DeadlineBounds, EscrowPreflightInput } from './escrow.js';

export { ANCHOR_DOMAIN, documentAnchor, verifyAnchor } from './anchor.js';
export type { AnchorInput, AnchorStatus } from './anchor.js';

export { reconcile } from './reconcile.js';
export type {
  Divergence,
  DivergenceDirection,
  DivergenceKind,
  DivergenceSeverity,
  ReconcileContext,
  Reconciliation,
} from './reconcile.js';

export { safeEmit } from './events.js';
export type { DecisionSource, EventSink, UnderwriterEvent } from './events.js';

export { ENFORCEMENT, Underwriter } from './underwriter.js';
export type { Authorization, Enforcement, Headroom, Quote, UnderwriterOptions } from './underwriter.js';

export { DOCUMENT_SOURCES, describeUnderwriterConfig, loadUnderwriterConfig } from './config.js';
export type { DocumentSource, DocumentsConfig, JournalConfig, UnderwriterConfig } from './config.js';

export { DEFAULT_MAX_CONNECTIONS, createPostgres } from './db.js';
export type { Postgres, PostgresOptions, Session, Sql, SqlParam } from './db.js';

export { deriveDocument } from './store/derive.js';
export { createFileDocumentStore } from './store/file.js';
export { createPostgresDocumentStore } from './store/postgres.js';
export type { DocumentStore, MandateBinding } from './store/types.js';

export { claimOwner } from './journal-store.js';
export type { JournalHandle, JournalStore } from './journal-store.js';
export { createFileJournalStore } from './journal-file.js';
export type { FileJournalOptions } from './journal-file.js';
export { createPostgresJournalStore } from './journal-postgres.js';

export { DEFAULT_JOURNAL_PAGE, MAX_JOURNAL_PAGE, createMandateRegistry } from './registry.js';
export type {
  DecisionResult,
  JournalPage,
  JournalView,
  MandateRegistry,
  MandateSummary,
  RefundResult,
  RegistryOptions,
  SettlementResult,
} from './registry.js';

export { createRouter } from './http/routes.js';
export type { Router, RouterOptions } from './http/routes.js';
export { createHttpServer, listen } from './http/server.js';
export type { RunningServer } from './http/server.js';
export type { ApiRequest, ApiResponse } from './http/io.js';

export { createUnderwriterService } from './service.js';
export type {
  Readiness,
  SpendDecision,
  SpendQuoteView,
  UnderwriterLookup,
  UnderwriterPort,
  UnderwriterService,
  UnderwriterServiceOptions,
} from './service.js';

export { createUnderwriterClient, createUnderwriterProbe } from './client.js';
export type { UnderwriterClientOptions } from './client.js';
