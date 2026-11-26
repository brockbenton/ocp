// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Script.sol";

import {ClubScript} from "./ClubScript.sol";

/// @notice Step 1. Deploys Timelock, Rep, registry and Governor. Fails unless the legacy
///         registry is already frozen. Env: see `smart-contract/.env.example`.
contract DeployClub is ClubScript {
    error GuardianMustBeContract(address guardian);

    function run() external returns (Club memory club) {
        Legacy memory legacy = _readLegacy();
        Config memory config = Config({
            relay: vm.envAddress("RELAY_WALLET"),
            guardian: vm.envAddress("GUARDIAN_SAFE"),
            officers: vm.envAddress("OFFICERS", ","),
            baseCid: vm.envString("BASE_CID"),
            halfLife: vm.envOr("HALF_LIFE_DAYS", uint256(180)) * 1 days,
            timelockDelay: 2 days,
            guardianTerm: 120 days,
            governor: _defaultSettings()
        });
        // The guardian is a founders' Safe. The override exists for local and test networks.
        if (config.guardian.code.length == 0 && !vm.envOr("ALLOW_EOA_GUARDIAN", false)) {
            revert GuardianMustBeContract(config.guardian);
        }

        vm.startBroadcast();
        club = _deployClub(config, legacy, _broadcaster());
        vm.stopBroadcast();

        console.log("ClubTimelock:       ", address(club.timelock));
        console.log("ClubRep:            ", address(club.rep));
        console.log("AttendanceRegistry2:", address(club.registry));
        console.log("ClubGovernor:       ", address(club.governor));
    }
}
