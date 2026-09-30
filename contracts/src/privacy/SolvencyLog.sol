// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Arbitrum's system precompile. On an Arbitrum chain `block.number` is an estimate of the L1
/// block, so the chain's own block number has to be read from here.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// A public log of epoch solvency roots. Each entry is the root of a Merkle-sum tree over the
/// protocol's public obligations and the balances that back them, read at `asOfBlock`. Anyone can
/// rebuild the tree from chain data at that block and check the root (services/solvency, the
/// verify command). Phase A: the inputs are public state, so no proof is needed to check it.
contract SolvencyLog {
    error NotPoster();
    error NotAdmin();
    error NotPendingAdmin();
    error StaleEpoch();
    error FutureEpoch();
    error StaleBlock();
    error FutureBlock();
    error ZeroAddress();

    struct Epoch {
        bytes32 root;
        uint128 liabilities;
        uint128 assets;
        uint64 asOfBlock;
        uint64 postedAt;
    }

    event EpochPosted(uint64 indexed epoch, bytes32 root, uint128 liabilities, uint128 assets, uint64 asOfBlock);
    event PosterSet(address indexed poster);
    event AdminTransferStarted(address indexed to);
    event AdminTransferred(address indexed to);

    IArbSys private constant ARB_SYS = IArbSys(address(100));

    address public admin;
    address public pendingAdmin;
    address public poster;
    uint64 public latestEpoch;

    mapping(uint64 => Epoch) private _epochs;

    constructor(address admin_, address poster_) {
        if (admin_ == address(0) || poster_ == address(0)) revert ZeroAddress();
        admin = admin_;
        poster = poster_;
        emit AdminTransferred(admin_);
        emit PosterSet(poster_);
    }

    /// Epochs are UTC days and only move forward, so a posted root can never be overwritten. An
    /// epoch cannot be ahead of today either: one posted far ahead would leave every later day
    /// stale and end the log. `asOfBlock` is an L2 block, later than the previous epoch's and not
    /// past the chain head.
    function post(uint64 epoch, uint64 asOfBlock, bytes32 root, uint128 liabilities, uint128 assets) external {
        if (msg.sender != poster) revert NotPoster();
        if (epoch <= latestEpoch) revert StaleEpoch();
        if (epoch > block.timestamp / 1 days) revert FutureEpoch();
        if (asOfBlock <= _epochs[latestEpoch].asOfBlock) revert StaleBlock();
        if (asOfBlock > ARB_SYS.arbBlockNumber()) revert FutureBlock();
        latestEpoch = epoch;
        _epochs[epoch] = Epoch(root, liabilities, assets, asOfBlock, uint64(block.timestamp));
        emit EpochPosted(epoch, root, liabilities, assets, asOfBlock);
    }

    function epochs(uint64 epoch) external view returns (Epoch memory) {
        return _epochs[epoch];
    }

    function setPoster(address poster_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (poster_ == address(0)) revert ZeroAddress();
        poster = poster_;
        emit PosterSet(poster_);
    }

    function transferAdmin(address to) external {
        if (msg.sender != admin) revert NotAdmin();
        pendingAdmin = to;
        emit AdminTransferStarted(to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(msg.sender);
    }
}
