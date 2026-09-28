import type { SVGProps } from 'react';

/**
 * Marks for the connectors that do not announce one. Wallets discovered over EIP-6963 ship their
 * own icon and that is what gets rendered for them, because a wallet's own artwork is the only
 * version of it that is current.
 */
type MarkProps = SVGProps<SVGSVGElement> & { readonly size?: number };

export function WalletConnectMark({ size = 24, ...props }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect width="24" height="24" rx="6" fill="#3396FF" />
      <path
        d="M7.2 9.2a6.8 6.8 0 0 1 9.6 0l.32.32a.33.33 0 0 1 0 .46l-1.09 1.09a.17.17 0 0 1-.24 0l-.44-.44a4.74 4.74 0 0 0-6.7 0l-.48.47a.17.17 0 0 1-.24 0L6.84 9.99a.33.33 0 0 1 0-.46l.36-.33Zm11.87 2.21.97.97a.33.33 0 0 1 0 .46l-4.37 4.38a.33.33 0 0 1-.47 0l-3.1-3.11a.08.08 0 0 0-.12 0l-3.1 3.1a.33.33 0 0 1-.46 0L4.04 12.8a.33.33 0 0 1 0-.46l.97-.98a.33.33 0 0 1 .47 0l3.1 3.11a.08.08 0 0 0 .12 0l3.1-3.1a.33.33 0 0 1 .47 0l3.1 3.1a.08.08 0 0 0 .12 0l3.1-3.1a.33.33 0 0 1 .47 0Z"
        fill="#fff"
      />
    </svg>
  );
}

export function SafeMark({ size = 24, ...props }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect width="24" height="24" rx="6" fill="#12FF80" />
      <path
        d="M15.6 6.4h-5.4a3.2 3.2 0 0 0 0 6.4h3.6a1.2 1.2 0 0 1 0 2.4H8.4v-1.1H6v3.5h5.4a3.2 3.2 0 0 0 0-6.4H7.8a1.2 1.2 0 0 1 0-2.4h5.4v1.1h2.4V6.4Z"
        fill="#121312"
      />
      <rect x="16.6" y="10.9" width="2.4" height="2.4" rx="0.5" fill="#121312" />
      <rect x="5" y="10.9" width="2.4" height="2.4" rx="0.5" fill="#121312" />
    </svg>
  );
}

export function BrowserWalletMark({ size = 24, ...props }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect width="24" height="24" rx="6" fill="#17171a" />
      <path d="M5.5 8.5h11a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 15.5V10a1.5 1.5 0 0 1 1.5-1.5Z" fill="#fff" />
      <path d="M6 6.5h8.5a1 1 0 0 1 1 1V8.5H6a1 1 0 0 1 0-2Z" fill="#c9c9d1" />
      <circle cx="15" cy="12.8" r="1.2" fill="#17171a" />
    </svg>
  );
}

export function CopyMark({ size = 14, ...props }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5A1.5 1.5 0 0 0 9 2H4a2 2 0 0 0-2 2v5a1.5 1.5 0 0 0 1.5 1.5" />
    </svg>
  );
}

export function CheckMark({ size = 14, ...props }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m3 8.5 3.2 3.2L13 5" />
    </svg>
  );
}

export function ExternalMark({ size = 12, ...props }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M6.5 3.5H3.5v9h9v-3" />
      <path d="M9.5 3.5h3v3M12.5 3.5 7 9" />
    </svg>
  );
}
