import { FacilitatorConfigError } from './errors.js';
import type { PaymentScheme } from './x402/contract.js';

/**
 * The package and export the facilitator settles through unless a deployment names another.
 *
 * Both are declared dependencies, so the workspace build catches a typo here long before the
 * first payment. `createExactScheme` is the assembled form: it takes flat configuration and
 * does the asset resolution and signer wiring that `createExactEvm` expects to be done already.
 */
const DEFAULT_SCHEME = '@bursar/x402';
const DEFAULT_FACTORY = 'createExactScheme';

export type SchemeModuleOptions = {
  readonly specifier?: string;
  readonly factory?: string;
  readonly configure: Readonly<Record<string, unknown>>;
};

/**
 * Loads the payment scheme at run time.
 *
 * The verifier lives in its own package so that the refusal matrix can be tested without a chain
 * and reused by anything else that needs it. Resolving it at run time keeps this service buildable
 * and testable on its own, and makes the failure loud and specific when the package is missing
 * instead of a stack trace from the module loader.
 *
 * `factory` is the name of an exported function taking the chain configuration and returning a
 * scheme. `configure` is whatever that function needs.
 */
export async function loadScheme(options: SchemeModuleOptions): Promise<PaymentScheme> {
  const specifier = options.specifier ?? DEFAULT_SCHEME;
  const factoryName = options.factory ?? DEFAULT_FACTORY;

  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    throw new FacilitatorConfigError(
      'scheme_module_missing',
      `could not load the payment scheme from ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      { specifier },
    );
  }

  const factory = loaded[factoryName];
  if (typeof factory !== 'function') {
    throw new FacilitatorConfigError(
      'scheme_factory_missing',
      `${specifier} exports no function named ${factoryName}`,
      { specifier, factory: factoryName, exported: Object.keys(loaded) },
    );
  }

  const scheme: unknown = await (factory as (config: unknown) => unknown)(options.configure);
  if (!isScheme(scheme)) {
    throw new FacilitatorConfigError(
      'scheme_shape_invalid',
      `${specifier}.${factoryName} returned something without verify, settle and supported`,
      { specifier, factory: factoryName },
    );
  }
  return scheme;
}

function isScheme(value: unknown): value is PaymentScheme {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.verify === 'function' &&
    typeof candidate.settle === 'function' &&
    typeof candidate.supported === 'function'
  );
}
