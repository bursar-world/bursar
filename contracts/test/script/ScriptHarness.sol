// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// Calls a script from the address it broadcasts as, which is what `forge script` does with the
/// key it is given. Etched wherever a test needs a key to act: a broadcast cannot be opened under
/// a prank, so the call has to come from the address itself.
contract Runner {
    function run(address script, bytes calldata data) external returns (bytes memory result) {
        bool ok;
        (ok, result) = script.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }
}

/// What every script suite needs: a namespace for the environment, a record file of its own, and a
/// way to act as a given key.
///
/// Foundry's environment is process-wide and is not part of the EVM state it snapshots, and suites
/// run in parallel. Each suite pins a prefix of its own on the scripts it drives, and writes its
/// record under a name of its own in `cache/bursar`, which is not committed.
abstract contract ScriptHarness is Test {
    string internal constant RECORDS = "cache/bursar";

    function _prefix() internal pure virtual returns (string memory);

    function _set(string memory key, string memory value) internal {
        vm.setEnv(string.concat(_prefix(), key), value);
    }

    function _unset(string memory key) internal {
        vm.setEnv(string.concat(_prefix(), key), "");
    }

    function _key(string memory key) internal pure returns (string memory) {
        return string.concat(_prefix(), key);
    }

    /// Writes `json` as this suite's record and points the scripts at it.
    function _useRecord(string memory name, string memory json) internal returns (string memory path) {
        vm.createDir(RECORDS, true);
        path = string.concat(RECORDS, "/", name, ".json");
        vm.writeFile(path, json);
        _set("BURSAR_RECORD", path);
    }

    /// The smallest record a script accepts: a chain, a settlement asset, and a flag saying
    /// whether this is a rehearsal.
    function _baseRecord(string memory network, uint256 chainId, bool local, address asset)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '{"network":"',
            network,
            '","chainId":',
            vm.toString(chainId),
            ',"status":"planned","local":',
            local ? "true" : "false",
            ',"settlementAsset":"',
            vm.toString(asset),
            '","settlementDecimals":6,"contracts":{},"verifiedOnChain":{}}'
        );
    }

    /// Acts as `who`. The runner is etched from its runtime code rather than deployed, so a call
    /// made right after `vm.expectRevert` is the call the expectation lands on.
    function _as(address who, address script, bytes memory data) internal returns (bytes memory) {
        if (who.code.length == 0) vm.etch(who, type(Runner).runtimeCode);
        return Runner(who).run(script, data);
    }

    /// Applies a parameter file the way `source` would, under this suite's prefix: every
    /// `export KEY=VALUE` line, quotes stripped. A value the shell has to compute is skipped, and
    /// the suite sets it itself.
    function _source(string memory file) internal {
        string[] memory lines = vm.split(vm.readFile(file), "\n");
        for (uint256 i; i < lines.length; ++i) {
            string memory line = vm.trim(lines[i]);
            if (vm.indexOf(line, "export ") != 0) continue;
            string memory assignment = vm.replace(line, "export ", "");
            uint256 at = vm.indexOf(assignment, "=");
            string[] memory parts = vm.split(assignment, "=");
            string memory value = vm.replace(vm.replace(parts.length > 1 ? parts[1] : "", '"', ""), "'", "");
            if (at == type(uint256).max || vm.indexOf(value, "$(") != type(uint256).max) continue;
            _set(parts[0], value);
        }
    }

    function _readAddress(string memory path, string memory key) internal view returns (address) {
        return vm.parseJsonAddress(vm.readFile(path), key);
    }

    function _readUint(string memory path, string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(vm.readFile(path), key);
    }

    function _has(string memory path, string memory key) internal view returns (bool) {
        return vm.keyExistsJson(vm.readFile(path), key);
    }
}
