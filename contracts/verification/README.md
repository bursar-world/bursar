# Verification inputs

The Solidity standard-JSON input for each deployed contract, as compiled at its deploy commit. Anyone can
submit one of these to an explorer or to Sourcify to check that the source here produces the code on chain.
`manifest.json` lists each contract's address, compiler, constructor arguments and linked libraries, and
whether its input matches exactly or partially.

Ten inputs give a partial match only: the compiled code equals the code on chain except for the metadata
hash that solc appends to it. They are the two collateral contracts, `CreditPool` and `CollateralVault`,
and the eight shielded-pool contracts: `ShieldedPool`, `ShieldedRelay`, the `Entrypoint` implementation
and proxy, `CommitmentVerifier`, `WithdrawalVerifier`, `PoseidonT3` and `PoseidonT4`. Their deployed
metadata was built with absolute remappings, which appear here as repository-relative paths, and the
metadata hash covers the remappings. All ten are being redeployed from a build without absolute paths.
Every other input matches exactly.
