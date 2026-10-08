import type { Address } from 'viem';

import { ADDRESSES, RHC } from './chain/rhc';

export type NavItem = { readonly href: string; readonly label: string };

export type SiteChrome = {
  readonly wordmark: string;
  readonly home: string;
  /** Names the navigation for a screen reader, which hears two copies of it on a narrow screen. */
  readonly navLabel: string;
  readonly nav: readonly NavItem[];
  readonly footer: {
    readonly settlement: {
      readonly network: string;
      readonly chainId: number;
      readonly asset: Address;
    };
    readonly legal: string;
    /** Where the project lives outside this app. Each opens in a new tab. */
    readonly channels: readonly { readonly href: string; readonly label: string; readonly mark: 'x' | 'github' }[];
  };
};

/**
 * The header, the navigation and the footer as data.
 *
 * The shell renders this and holds no copy of its own. A new identity is a change here and in the
 * theme; the markup that arranges them stays where it is.
 */
export const SITE: SiteChrome = {
  wordmark: 'BURSAR®',
  /** The public site. The console has its own root layout, so the wordmark is a full load, as on the site. */
  home: 'https://bursar.world',
  navLabel: 'Surfaces',
  /**
   * The nine surfaces. Each has one job, and this is the only place their order is decided.
   *
   * The console comes first and the workspace, where its mandates are drafted, beside it. Then the
   * other parties to a payment, in the order the money moves: the address that is paid and the
   * bonded resolver who rules when payer and payee disagree. Then the token, then the two surfaces
   * that change parameters, then reference.
   */
  nav: [
    { href: '/console', label: 'Console' },
    { href: '/workspace', label: 'Workspace' },
    { href: '/providers', label: 'Providers' },
    { href: '/resolvers', label: 'Resolvers' },
    { href: '/token', label: 'Token' },
    { href: '/governance', label: 'Governance' },
    { href: '/ops', label: 'Operations' },
    { href: '/docs', label: 'Developers' },
    { href: '/status', label: 'Status' },
  ],
  footer: {
    settlement: { network: RHC.name, chainId: RHC.chainId, asset: ADDRESSES.usdg },
    legal:
      '$BRSR is a governance and staking token. It is not a claim on Robinhood, on Robinhood Chain, on Paxos or on USDG, and none of them endorses Bursar.',
    channels: [
      { href: 'https://x.com/UseBursar', label: 'Follow us', mark: 'x' },
      { href: 'https://github.com/bursar-world', label: 'GitHub', mark: 'github' },
    ],
  },
};
