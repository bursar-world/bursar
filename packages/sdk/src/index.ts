export { usdg, formatUsdg, MICRO_SCALE, micro, toMicro, microToAtomicString } from './money.js';
export type { Micro } from './money.js';

export { BRSR_DECIMALS, BRSR_SCALE, brsr, formatBrsr, parseBrsr, toBrsr } from './brsr.js';
export type { Brsr } from './brsr.js';

export { connect, explorerTx, isConnection, requireSigner, writeOptions, DEFAULT_RECEIPT_TIMEOUT_MS } from './connection.js';
export type { Connection, ConnectOptions, MandateAddresses, Signer } from './connection.js';

export {
  DEFAULT_TTL_SECONDS,
  MandateAccountClient,
  encodeLimits,
  mandateAccount,
} from './mandate.js';
export type {
  Decision,
  HireReceipt,
  HireRequest,
  JobStatus,
  MandateFetchOptions,
  PayRequest,
  PaymentReceipt,
  PreviewRequest,
  WithdrawArgs,
} from './mandate.js';

export { RwaClient, RwaUnavailableError, UnknownAssetError, rwa } from './rwa.js';
export type { BuyReceipt, FeedPrice, Holding, ParkedPosition, RwaAsset } from './rwa.js';
export {
  CollateralClient,
  CollateralUnavailableError,
  NoDebtError,
  NotCollateralLaneError,
  collateral,
} from './collateral.js';
export type {
  CollateralAccount,
  CollateralAsset,
  CollateralPosition,
  CollateralTiers,
  HaircutTier,
} from './collateral.js';

export { EscrowClient, escrow } from './escrow.js';
export type { EscrowTerms, ReleaseArgs } from './escrow.js';

export {
  MAX_JOB_BYTES,
  jobCommit,
  jobDocument,
  jobURI,
  parseJobDocument,
  readJobURI,
  verifyDelivery,
} from './job.js';
export type { JobDocument, JobSpec } from './job.js';

export {
  DELIVERY_EVIDENCE_TYPES,
  EVIDENCE_DOMAIN_NAME,
  EVIDENCE_DOMAIN_VERSION,
  MAX_OUTPUT_URI_CHARS,
  MAX_STATEMENT_CHARS,
  PAYER_STATEMENT_TYPES,
  deliveryEvidenceTypedData,
  encodeEvidence,
  evidenceDomain,
  parseEvidence,
  payerStatementTypedData,
  recoverEvidenceSigner,
  signDeliveryEvidence,
  signPayerStatement,
  verifyEvidence,
} from './evidence.js';
export type { DeliveryEvidence, EvidenceSubmission, EvidenceWire, PayerStatement } from './evidence.js';

export { DisputeClient, DisputePhase, disputes, readTerms } from './dispute.js';
export type {
  DisputePhaseName,
  DisputeRecord,
  DisputeRuling,
  DisputeTerms,
} from './dispute.js';

export { ResolverClient, SCORE_MAX, commitmentFor, resolver } from './resolver.js';
export type {
  ClaimReceipt,
  CommitReceipt,
  OpenDispute,
  ResolverStanding,
  ResolverStatus,
} from './resolver.js';

export { ProviderClient, provider } from './provider.js';
export type { PendingWithdrawal, ProviderReputation, ProviderStatus } from './provider.js';

export { issuerRefusal, providerRefusal, resolverRefusal } from './refusals.js';
export type { Refusal, RefusalOwner } from './refusals.js';

export { createMandate, deployMandate, mandatesOf, predictMandate } from './factory.js';
export type { DeployedMandate, MandateSeed } from './factory.js';

export {
  MANDATE_ACCOUNT_DOMAIN_NAME,
  MANDATE_ACCOUNT_DOMAIN_VERSION,
  SET_LIMITS_TYPES,
  SET_LIMITS_TYPES_V1,
  SPEND_APPROVAL_TYPES,
  assertMandateDomain,
  limitsV1,
  mandateDomain,
  signLimitsAuthorization,
  signSpendApproval,
} from './authorization.js';
export type { LimitsAuthorization } from './authorization.js';

export { canonicalStringify, capabilityId, commitCanonical, toCapabilityId, toDataUri } from './commit.js';
export { random32 } from './random.js';

export { LockStatus, MerchantGate, WindowKind, isNoLock, toLockStatus } from './types.js';
export type {
  Lock,
  MandateLimits,
  MandateLimitsInput,
  MandateStatus,
  Remaining,
  SignedApproval,
  SpendApproval,
  SpendWindow,
  TotalSpend,
} from './types.js';

export {
  AmbiguousSpendError,
  CallRefusedError,
  ContractRevertError,
  GasFailureError,
  InsufficientFundsError,
  InvalidArgumentError,
  MandateDeniedError,
  MissingEventError,
  NoAcceptablePaymentError,
  NotAMandateAccountError,
  NoSignerError,
  PaymentRejectedError,
  SubmittedButUnconfirmedError,
  TransactionRevertedError,
  UnconfirmedCommitError,
  UnsupportedChainError,
  denialReasonFor,
  isGasFailure,
} from './errors.js';
export type {
  DenialReason,
  GasFailure,
  GasFailureReason,
  MandateDenial,
  MandateSnapshot,
  MissingContract,
} from './errors.js';

export { formatDuration, toDate } from './format.js';
export { contractSaidNo, decodeRevertData, gasFailureFrom, returnedNoData, revertFrom } from './revert.js';
export type { GasSignal, RevertInfo } from './revert.js';
export { preflight, sendCall } from './send.js';
export type { Call, ExplainRevert, Sent } from './send.js';
export { awaitReceipt, logsFrom } from './receipt.js';

export {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  assetDomain,
  AUTHORIZATION_MARGIN_SECONDS,
  authorizationFor,
  encodeAuthorization,
  signTransferAuthorization,
} from './x402/authorization.js';
export type { TransferAuthorization } from './x402/authorization.js';

export {
  CHALLENGE_HEADER,
  PAYMENT_HEADER,
  SETTLEMENT_HEADER,
  canonicalNetwork,
  encodeBase64Json,
  parseChallenge,
  sameNetwork,
  selectRequirement,
} from './x402/requirements.js';
export type {
  PaymentRequirements,
  RequirementFilter,
  X402Challenge,
  X402Version,
} from './x402/requirements.js';

export { LANE_SCHEME, paidFetch, payRequest } from './x402/fetch.js';
export type {
  FetchTarget,
  PaidResponse,
  PayRequestOptions,
  PaymentAuthority,
  MandateSpender,
  PaymentGate,
  PaymentLane,
  PaymentRecord,
  Settlement,
} from './x402/fetch.js';

/**
 * The spend-class namespaces. `pay` spends under `service:` and `hire` under `hire:`; a mandate
 * allows a class by allowing capability ids in its namespace. Compute those ids with
 * `classCapabilityId('service', 'gpu.render:1')`.
 */
export {
  SPEND_CLASSES,
  SPEND_CLASS_INFO,
  SpendClassError,
  TOTAL_BUDGET_MIN_SECONDS,
  bareLabel,
  classCapabilityId,
  classLabel,
  classOfLabel,
  isTotalBudgetWindow,
  totalBudgetWindowSeconds,
} from '@bursar/core';
export type { SpendClass, SpendClassInfo } from '@bursar/core';

export {
  ERC5564_SCHEME_SECP256K1,
  ERC6538_REGISTRY,
  SealOpenError,
  encodeMetaAddress,
  erc6538Abi,
  isSealedURI,
  open,
  openSealedURI,
  openText,
  publishedViewingKey,
  seal,
  sealedURI,
  viewingKeyOfMetaAddress,
} from './seal.js';

export {
  FUNDS_KEY_VERSION,
  FUNDS_KEY_WARNING,
  FundsKeySignatureError,
  VIEWING_KEY_VERSION,
  deriveSpendingKey,
  deriveViewingKey,
  fundsKeyMaterial,
  fundsKeyTypedData,
  viewingKeyMessage,
} from './viewing-key.js';
export type { FundsKeyContext, ViewingKey } from './viewing-key.js';

export {
  COMMITTED_CLASSES,
  FRESH_STATE,
  TermsLockedError,
  TermsMismatchError,
  amendArgs,
  capabilityIdsOf,
  carriedState,
  circuitTerms,
  classesOf,
  commit,
  committedCapability,
  committedMandateAccountAbi,
  committedMandateFactoryAbi,
  createArgs,
  latestSealedTerms,
  openTerms,
  predictAccount,
  readTermsDocument,
  recoverState,
  sealTerms,
  startOf,
  writeTerms,
} from './committed.js';
export type {
  CommittedClass,
  Commitment,
  CounterState,
  SealedFor,
  SealedTermsRecord,
  TermsDocument,
  TermsInput,
} from './committed.js';

export { disclosureSlice, openDisclosure } from './disclosure.js';
export type { DisclosureSlice, OpenedDisclosure } from './disclosure.js';

export {
  ERC5564_ANNOUNCER,
  STEALTH_ROLES,
  announceArgs,
  announcementMetadata,
  checkStealthAddress,
  computeStealthKey,
  deriveStealthKeys,
  erc5564AnnouncerAbi,
  fetchAnnouncements,
  generateStealthAddress,
  metaAddressURI,
  parseMetaAddress,
  planStealthMandate,
  recoverStealthMandates,
  registerKeysArgs,
  scanAnnouncements,
} from './stealth.js';
export type {
  Announcement,
  GeneratedStealthAddress,
  MetaAddressKeys,
  RecoveredMandate,
  StealthIdentity,
  StealthKeys,
  StealthMandatePlan,
  StealthMatch,
  StealthRole,
} from './stealth.js';

export { AGENT_HANDOFF_KIND, agentHandoff, agentHandoffFileName, readAgentHandoff } from './handoff.js';
export type { AgentHandoff } from './handoff.js';

export {
  ACCESS_REGISTRY,
  ASP_POSTMAN_ROLE,
  SHIELDED_KEYS_KIND,
  SHIELDED_TREE_DEPTH,
  SNARK_SCALAR_FIELD,
  accessRegistryAbi,
  associationSetBytes,
  associationSetCid,
  blockedDepositors,
  buildAssociationSet,
  changeSecrets,
  commitmentOf,
  decodeRelayData,
  deriveLegacyShieldedKeys,
  deriveShieldedKeys,
  depositSecrets,
  encodeRelayData,
  fetchAssociationSet,
  fetchPoolEvents,
  fetchRelayQuote,
  isStaleSetRefusal,
  labelOf,
  leanProof,
  leanRoot,
  leanTree,
  noteOf,
  nullifierHashOf,
  precommitmentOf,
  proofFromWire,
  proofToWire,
  ragequitInput,
  randomShieldedKeys,
  recoverNotes,
  relayWithFreshProof,
  scopeOf,
  ShieldedServiceError,
  shieldedEntrypointAbi,
  shieldedKeyFile,
  shieldedPoolAbi,
  shieldedRelayAbi,
  submitRelay,
  toSolidityProof,
  withdrawInput,
  withdrawSignals,
  withdrawalContext,
} from './shielded.js';
export type {
  AssociationSet,
  LeanProof,
  Note,
  NoteSecrets,
  OwnedNote,
  PoolDeposit,
  PoolEvents,
  PoolRagequit,
  PoolWithdrawal,
  RelayData,
  RelayQuote,
  RelayRequest,
  RelayResult,
  ShieldedKeyFile,
  ShieldedKeys,
  SnarkjsProof,
  SolidityProof,
  WireProof,
  Withdrawal,
} from './shielded.js';
