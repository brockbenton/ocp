// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

import {AttendanceRegistry} from "../src/AttendanceRegistry.sol";
import {ClubDeployment} from "./ClubDeployment.sol";

/// @notice Shared input reading for the bootstrap scripts.
abstract contract ClubScript is Script, ClubDeployment {
    /// @dev Reads `LEGACY_REGISTRY` and the JSON file named by `LEGACY_DATA`
    ///      (`{"roleHolders": [], "sessionIds": [], "accounts": []}`).
    function _readLegacy() internal view returns (Legacy memory legacy) {
        string memory json = vm.readFile(vm.envString("LEGACY_DATA"));
        legacy.registry = AttendanceRegistry(vm.envAddress("LEGACY_REGISTRY"));
        legacy.roleHolders = vm.parseJsonAddressArray(json, ".roleHolders");
        legacy.sessionIds = vm.parseJsonUintArray(json, ".sessionIds");
        legacy.accounts = vm.parseJsonAddressArray(json, ".accounts");
    }

    function _broadcaster() internal returns (address sender) {
        (, sender,) = vm.readCallers();
    }
}
