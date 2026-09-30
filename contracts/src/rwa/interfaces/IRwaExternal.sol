// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The outside contracts the RWA lane reads, declared to the functions it calls. Each one was
/// read on Robinhood Chain 4663 before this file was written.

/// Chainlink aggregator proxy. Every feed the registry accepts answers with 8 decimals.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// Robinhood stock and treasury tokens. `uiMultiplier` is read for share display and change
/// detection only: the Chainlink feed already prices one raw token.
interface IRobinhoodStock {
    function oraclePaused() external view returns (bool);
    function tokenPaused() external view returns (bool);
    function uiMultiplier() external view returns (uint256);
}

/// Robinhood's access registry at 0xe10b6f6B275de231345c20D14Ab812db62151b00.
interface IAccessRegistry {
    function isBlocked(address account) external view returns (bool);
    function paused() external view returns (bool);
}

/// Uniswap v4 StateView at 0xf3334192d15450cdd385c8b70e03f9a6bd9e673b.
interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}
