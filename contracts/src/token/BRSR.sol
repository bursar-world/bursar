// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

import {IBRSR} from "./interfaces/IBRSR.sol";

/// One billion BRSR, minted once, never again.
///
/// The whole supply is created inside this constructor and handed to the four addresses the
/// deployment names. After that the contract has no privileged party at all: no minter, no
/// owner, no pauser, no upgrade path. There is nothing here for `AdminTimelock` to administer.
/// Governance decides protocol parameters; it does not decide how many tokens exist.
///
/// `ERC20Permit` gives an approval that costs the holder no gas, which matters on a chain
/// where gas is the settlement asset itself. `ERC20Votes` gives governance a supply it can
/// count without snapshotting by hand. Voting power has to be delegated before it counts,
/// including to yourself: an undelegated balance votes nothing. That is upstream behaviour,
/// not a choice made here.
contract BRSR is IBRSR, ERC20, ERC20Permit, ERC20Votes {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// Staking rewards, resolver incentives and integration grants, released on a published
    /// schedule.
    uint256 public constant COMMUNITY_ALLOCATION = 800_000_000e18;

    /// Four-year vest behind a one-year cliff. The address here is the vesting contract.
    uint256 public constant TEAM_ALLOCATION = 100_000_000e18;

    uint256 public constant TREASURY_ALLOCATION = 50_000_000e18;

    /// Seeds the Uniswap v4 pool.
    uint256 public constant LIQUIDITY_ALLOCATION = 50_000_000e18;

    constructor(Allocation memory to) ERC20("Bursar", "BRSR") ERC20Permit("Bursar") {
        if (
            to.community == address(0) || to.team == address(0) || to.treasury == address(0)
                || to.liquidity == address(0)
        ) {
            revert ZeroAddress();
        }

        // Minted once to this contract and then moved out, never minted four times.
        // That leaves exactly one mint in the token's history, taken while the supply was
        // still zero, and `_update` reverts on any other. Nothing burns, so the supply can
        // never fall back to zero and re-open that door.
        _mint(address(this), TOTAL_SUPPLY);
        _transfer(address(this), to.community, COMMUNITY_ALLOCATION);
        _transfer(address(this), to.team, TEAM_ALLOCATION);
        _transfer(address(this), to.treasury, TREASURY_ALLOCATION);
        _transfer(address(this), to.liquidity, LIQUIDITY_ALLOCATION);

        emit AllocationMinted(to.community, to.team, to.treasury, to.liquidity);
    }

    /// Governance counts by timestamp, not by block height. The chain's block cadence is not
    /// a published constant and a timelock measured in days has to agree with a voting period
    /// measured the same way. A governor built against this token must report the same clock.
    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // forge-lint: disable-next-item(mixed-case-function)
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        if (from == address(0) && totalSupply() != 0) revert SupplyIsFixed();
        super._update(from, to, value);
    }
}
