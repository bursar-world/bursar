# Verification inputs

The Solidity standard-JSON input for each deployed contract, as compiled at its deploy commit. Anyone can
submit one of these to an explorer or to Sourcify to check that the source here produces the code on chain.
`manifest.json` lists each contract's address, compiler, constructor arguments and linked libraries.

Some inputs were compiled with absolute remappings. Those paths are written here as repository-relative
paths, so those contracts reproduce everything except the metadata hash.
