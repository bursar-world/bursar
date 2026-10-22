// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Endowment} from "./Endowment.sol";

/// Carries the endowment's creation code so the factory does not have to: the two together are
/// over the contract size limit. Anyone may call it, but an endowment made here directly is not in
/// the factory's list and cannot mint patron marks; the factory is what makes one an endowment.
contract EndowmentDeployer {
    function deploy(address settlor, Endowment.Terms calldata t, Endowment.Wiring calldata w)
        external
        returns (Endowment)
    {
        return new Endowment(settlor, t, w);
    }
}
