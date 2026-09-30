// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUsdg} from "./MockUsdg.sol";

/// A settlement asset that publishes a second, larger view of the same balance.
///
/// `nativeBalanceOf` is the same money as `balanceOf`, scaled by 1e12. Nothing may add the two,
/// and nothing may take a ledger figure from the larger one: doing either reports a holder's
/// money a trillion times over. The tests that stand on this assert the property directly and
/// scan the deployed bytecode for the selector, so a contract that learned to read it would fail
/// in this suite.
///
/// USDG on chain 4663 does not do this, and neither does any token Bursar settles in today. It
/// sits next to the fee-on-transfer, inflating and shrinking mocks as one more thing a token can
/// do that accounting has to survive. A USDC precompile that doubles as a chain's gas token does
/// do it, which is why the property was worth writing down.
contract DualViewERC20 is MockUsdg {
    /// 1e18 in the larger view equals 1e6 here.
    uint256 public constant NATIVE_DECIMAL_SCALE = 1e12;

    /// The eighteen-decimal view of the same balance. Adding this to `balanceOf` counts the
    /// holder's money twice, which is the mistake this mock exists to catch.
    function nativeBalanceOf(address account) external view returns (uint256) {
        return balanceOf(account) * NATIVE_DECIMAL_SCALE;
    }
}
