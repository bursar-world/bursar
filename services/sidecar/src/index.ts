export { canonicalStringify, capabilityId, commitCanonical } from './commit.js';

export { loadConfig } from './config.js';
export type { LoadedConfig, SidecarConfig } from './config.js';

export { LockStatus, WriteFailed, createEscrowPort, hasResolver, inFlightHash, lockStatusName } from './escrow.js';
export type {
  BlockRef,
  EscrowPort,
  EscrowPortOptions,
  EscrowTerms,
  LockRecord,
  LockedLog,
  TxOutcome,
} from './escrow.js';

export { createOutputReader, createOutputWriter, executeJob, outputURI, parseRoutes, readRoutes } from './executor.js';
export type {
  CapabilityRoute,
  ExecutionOutcome,
  ExecutorOptions,
  FetchLike,
  FetchPolicy,
  LockJob,
  OutputReader,
  OutputUriPolicy,
  OutputWriter,
  RouteTable,
} from './executor.js';

export { EvidenceRejected, createEvidencePoster } from './evidence.js';
export type { Delivered, EvidencePoster, EvidencePosterOptions } from './evidence.js';

export { createGasMonitor, readGasBalance } from './gas.js';
export type { BalanceReader, GasMonitor, GasMonitorOptions } from './gas.js';

export { createLogger, describeError } from './log.js';
export type { LogFields, LogSink, LogValue, Logger } from './log.js';

export { createSigner } from './signer.js';
export type { Signer, SignerOptions } from './signer.js';

export { claimState, createFileStateStore } from './state.js';
export type { StateClaim, StateStore, WatcherState } from './state.js';

export { DEFAULT_BLOCK_RANGE, createWatcher } from './watcher.js';
export type { Escalation, Watcher, WatcherOptions } from './watcher.js';
