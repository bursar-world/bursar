// Nothing in the workspace imports this package; the binaries are its interface. What stays here is
// the surface for embedding the service in another process: configuration, the schema, and the
// service itself with the one collaborator it cannot build.
export { loadConfig, describeConfig } from './config.js';
export type { FacilitatorConfig } from './config.js';

export { FacilitatorConfigError, LedgerError, RequestError } from './errors.js';

export { migrate, migrationPlan } from './db/migrate.js';
export type { MigrationPlan, MigrationResult } from './db/migrate.js';

export { createFacilitatorService } from './service.js';
export type { FacilitatorService, ServiceOptions } from './service.js';
export type { PaymentScheme } from './x402/contract.js';
