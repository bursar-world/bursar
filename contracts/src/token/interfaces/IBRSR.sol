// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The BURSAR token: a fixed supply, minted once, split four ways at deployment.
///
/// The token exists so that the parts of this system that are supposed to have capital at
/// risk actually do. Staked BRSR takes first loss on the collateralized lane, at a capped rate,
/// and the lender carries the rest. Resolver bonds are posted in it, a staked balance reduces
/// the facilitator fee, and the parameters behind all three are governed. Nothing else is
/// claimed for it.
///
/// BRSR carries eighteen decimals. The settlement asset does not: USDG is six. The two unit
/// systems meet inside the staking pool and nowhere else, and they are never added.
///
/// BRSR is not a claim on USDG, on its issuer or on Robinhood Chain, and none of them endorses
/// it.
interface IBRSR {
    error ZeroAddress();

    /// Raised if anything ever tries to mint after construction. The supply is fixed by the
    /// code path, not by the absence of a function: the only mint in this contract is
    /// the one that runs while the total supply is still zero, and the total supply can never
    /// return to zero because nothing here burns.
    error SupplyIsFixed();

    /// Where the four shares of the supply land at deployment: 80 / 10 / 5 / 5.
    ///
    /// `team` is expected to be a vesting contract rather than a wallet, because a team
    /// allocation that can move on day one is a promise instead of a term. Nothing in this
    /// contract enforces that, which is why the deployment reads the address back and the
    /// token page publishes it.
    struct Allocation {
        address community;
        address team;
        address treasury;
        address liquidity;
    }

    event AllocationMinted(
        address indexed community, address indexed team, address indexed treasury, address liquidity
    );
}
