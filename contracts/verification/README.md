# Verification inputs

The Solidity standard-JSON input for each deployed contract, as compiled at its deploy commit. Anyone can
submit one of these to an explorer or to Sourcify to check that the source here produces the code on chain.
`manifest.json` lists each contract's address, compiler, constructor arguments and linked libraries, and
whether its input matches exactly or partially.

The `v4-` entries are the current contract set on Robinhood Chain, and the `v3-` entries the previous
one, which still serves what was opened through it. `script/verification-inputs.mjs` wrote both from the
deploy logs and compiled each input before accepting it: every one reproduces the creation code of its
deploy transaction byte for byte, metadata included. In each set the six contracts built for the shielded
pool carry the two Poseidon libraries in `settings.libraries`, because the run that deployed them linked
the libraries at compile time and solc records that in the metadata.

The other entries belong to the earlier sets, kept as the account of what ran. Ten of them match only
partially: `CreditPool`, `CollateralVault` and the eight shielded-pool contracts were built with absolute
remappings, which appear here as repository-relative paths, and the metadata hash covers the remappings.
`PoseidonT3` and `PoseidonT4` carry over into the current set unchanged, so those two stay partial.
