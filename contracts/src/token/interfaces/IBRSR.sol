// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The Bursar token: a fixed supply, minted once, split four ways at deployment.
///
/// The token exists so that the parts of this system that are supposed to have capital at
/// risk have it. Staked BRSR is slashed, at a capped rate, when the collateral lane writes off
/// a line. Resolver bonds are posted in it, a staked balance reduces the facilitator fee, and
/// the parameters behind all three are governed. Nothing else is claimed for it.
///
/// BRSR carries eighteen decimals. The settlement asset does not: USDG is six. The two are
/// never added: contracts that hold both keep separate ledgers or convert at a stated price.
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
