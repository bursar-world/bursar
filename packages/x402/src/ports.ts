import type { TypedData } from 'viem';

/**
 * Everything this package needs from a chain and from a key holder, and nothing more.
 *
 * Two reasons for the narrow surface. The first is a standing design decision: no service in
 * this repo holds a user's key, and the only key the facilitator holds is its own relayer key. A
 * package that could construct an account from a private key would invite exactly that. `send`
 * takes finished calldata, so whoever implements it owns the key and this package never sees one.
 *
 * The second is that verification is decision logic, not network code. Against these ports the
 * whole verdict matrix is testable without a chain, which is how the test suite runs offline.
 */

export type Eip712DomainFields = {
  readonly name: string;
  /** Absent for Permit2, which omits it from its EIP712Domain type. */
  readonly version?: string;
  readonly chainId: number;
  readonly verifyingContract: `0x${string}`;
};

export type TypedDataField = { readonly name: string; readonly type: string };

/**
 * viem's own type, because the EIP-712 encoder needs the literal field types to encode against and
 * a widened `Record<string, ...>` silently loses them.
 */
export type TypedDataTypes = TypedData;

export type TypedDataCheck = {
  /** The claimed signer. A contract wallet is checked through EIP-1271 by the adapter. */
  readonly address: `0x${string}`;
  readonly domain: Eip712DomainFields;
  readonly types: TypedDataTypes;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
  readonly signature: `0x${string}`;
};

/**
 * What a token reports about itself. The domain is read, never assumed.
 *
 * `version` is optional because not every token publishes one. USDG on Robinhood Chain is a
 * diamond proxy and `version()` reverts with `FacetNotFound`, while `name`, `decimals` and
 * `DOMAIN_SEPARATOR` all answer. Undefined means the token did not say, which is a different fact
 * from an empty version and has to stay distinguishable: `resolveAsset` supplies a version in that
 * case and then proves it against the separator the token does publish.
 */
export type TokenIdentity = {
  readonly name: string;
  readonly version?: string;
  readonly decimals: number;
  readonly domainSeparator: `0x${string}`;
};

/**
 * One answer from the token about one of its own controls.
 *
 * Three states rather than two, because "did not answer" is two different facts. USDG is a diamond
 * proxy: a call it routes to no facet reverts `FacetNotFound`, which says the control is not on the
 * token any more, while a read that times out says only that nobody asked it successfully. Both
 * refuse. One needs somebody to look at what the token exposes now, the other needs the chain back.
 */
export type ControlReading =
  | { readonly state: 'read'; readonly value: boolean }
  | { readonly state: 'absent'; readonly detail: string }
  | { readonly state: 'unreadable'; readonly detail: string };

/** What the token says about one address, named so a refusal can name it too. */
export type PartyControl = {
  readonly address: `0x${string}`;
  readonly frozen: ControlReading;
};

/**
 * The token issuer's view of one payment: whether the asset moves at all, and whether these
 * parties may move it. Neither is the operator's to set and neither is the payer's.
 */
export type IssuerControls = {
  readonly asset: `0x${string}`;
  readonly paused: ControlReading;
  /** One reading per party asked about, in the order they were asked. */
  readonly parties: readonly PartyControl[];
};

/** A transaction to submit, already encoded against a typed ABI. */
export type SettlementCall = {
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
};

export type TransactionReceipt = {
  readonly status: 'success' | 'reverted';
  readonly gasUsed: bigint;
};

export type PaymentChain = {
  readonly chainId: number;

  verifyTypedData(check: TypedDataCheck): Promise<boolean>;

  /** name, version, decimals and DOMAIN_SEPARATOR, in one round of reads. */
  tokenIdentity(token: `0x${string}`): Promise<TokenIdentity>;

  balanceOf(token: `0x${string}`, owner: `0x${string}`): Promise<bigint>;

  allowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint>;

  /**
   * `paused()` on the asset and `isFrozen(address)` on each party, in one batch.
   *
   * It never throws. A control that refuses to answer is a reading of its own, because the caller
   * has to tell a facet the token no longer routes from a chain that did not come back, and the
   * two are fixed by different people.
   */
  issuerControls(
    token: `0x${string}`,
    parties: readonly `0x${string}`[],
  ): Promise<IssuerControls>;

  /** EIP-3009 replay protection. True once the authorisation has been spent. */
  authorizationState(
    token: `0x${string}`,
    authorizer: `0x${string}`,
    nonce: `0x${string}`,
  ): Promise<boolean>;

  /** EIP-2612 nonces are a counter, so the next permit must carry exactly this value. */
  permitNonce(token: `0x${string}`, owner: `0x${string}`): Promise<bigint>;

  /** One 256-bit word of Permit2's unordered nonce bitmap. */
  nonceBitmap(permit2: `0x${string}`, owner: `0x${string}`, word: bigint): Promise<bigint>;

  hasCode(address: `0x${string}`): Promise<boolean>;

  /** Throws if the call would revert. Run as the relayer, because it is the relayer that pays. */
  simulate(call: SettlementCall, from: `0x${string}`): Promise<void>;

  waitForReceipt(hash: `0x${string}`, timeoutMs: number): Promise<TransactionReceipt>;
};

/**
 * The relayer. It holds one key, its own, and the gas float behind it is an address separate from
 * settlement and collateral.
 */
export type SettlementSigner = {
  readonly address: `0x${string}`;
  send(call: SettlementCall): Promise<`0x${string}`>;
};
