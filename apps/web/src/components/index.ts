/**
 * Every primitive, in one place, for a client component.
 *
 * A server component should import the module it needs instead. Half of what is re-exported here
 * carries 'use client', so a barrel import from a server page pulls the wallet stack into a route
 * that renders static text: `@/components/layout` costs 104 kB of shared JavaScript, this barrel
 * costs 281 kB.
 *
 * Server-safe on their own: layout, badge, table, stat, shell.
 * Client only: button, address, address-input, fields, modal, amount-input, tx-button,
 * error-surface, instant. Status renders client state and is imported from a client component.
 */
export { Button, IconButton } from './button';
export type { ButtonProps, ButtonSize, ButtonTone } from './button';

export { Badge, LevelBadge, LevelDot, levelWord } from './badge';

export { Card, EmptyState, Field, FieldGrid, Section, Skeleton } from './layout';

export { Table } from './table';
export type { Column, TableProps } from './table';

export { LimitBar, Stat, StatGrid } from './stat';
export type { StatProps } from './stat';

export { Address, CopyControl, TxHash } from './address';
export type { AddressProps } from './address';

export { Modal } from './modal';
export type { ModalProps } from './modal';

export { AmountInput } from './amount-input';
export type { AmountAsset, AmountInputProps } from './amount-input';

export { AddressInput, readAddress } from './address-input';
export type { AddressReading } from './address-input';

export { SelectField, TextField } from './fields';
export type { SelectFieldProps, SelectOption, TextFieldProps } from './fields';

export { TxButton, preventNavigation } from './tx-button';
export type { TxButtonProps, TxContext, TxPhase } from './tx-button';

export { ErrorSurface, errorLine, isUserRejection } from './error-surface';
export type { ErrorSurfaceProps, MandateShapedError } from './error-surface';

export { Blockers, ChecksList, NextActionLine, StatusList, StatusRow, StatusStrip, Unread } from './status';

export { Countdown, Instant } from './instant';

export { Shell } from './shell';
