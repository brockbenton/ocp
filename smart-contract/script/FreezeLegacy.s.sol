// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Script.sol";

import {ClubScript} from "./ClubScript.sol";

/// @notice Step 0. IRREVERSIBLE: closes every legacy session, revokes every role and
///         renounces the legacy admin. Broadcast with the legacy DEFAULT_ADMIN_ROLE wallet.
contract FreezeLegacy is ClubScript {
    function run() external {
        Legacy memory legacy = _readLegacy();
        vm.startBroadcast();
        _freezeLegacy(legacy, _broadcaster());
        vm.stopBroadcast();
        _requireLegacyFrozen(legacy);
        console.log("Legacy registry frozen:", address(legacy.registry));
    }
}
