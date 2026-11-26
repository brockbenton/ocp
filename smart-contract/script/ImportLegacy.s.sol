// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Script.sol";

import {AttendanceRegistry2} from "../src/AttendanceRegistry2.sol";
import {ClubGovernor} from "../src/ClubGovernor.sol";
import {ClubRep} from "../src/ClubRep.sol";
import {ClubTimelock} from "../src/ClubTimelock.sol";
import {ClubScript} from "./ClubScript.sol";

/// @notice Steps 2 and 3. Imports legacy attendance in batches; with `FINALIZE=true` it then
///         finalizes the import and renounces the deployer's Timelock admin (IRREVERSIBLE).
///         Broadcast with the wallet that ran `DeployClub`.
contract ImportLegacy is ClubScript {
    function run() external {
        Legacy memory legacy = _readLegacy();
        Club memory club = Club({
            timelock: ClubTimelock(payable(vm.envAddress("CLUB_TIMELOCK"))),
            rep: ClubRep(vm.envAddress("CLUB_REP")),
            registry: AttendanceRegistry2(vm.envAddress("CLUB_REGISTRY")),
            governor: ClubGovernor(payable(vm.envAddress("CLUB_GOVERNOR")))
        });
        uint256 batchSize = vm.envOr("IMPORT_BATCH_SIZE", _defaultBatchSize(legacy.sessionIds.length));
        bool finalize = vm.envOr("FINALIZE", false);

        _requireLegacyFrozen(legacy);
        vm.startBroadcast();
        address deployer = _broadcaster();
        _importLegacy(club.rep, legacy, batchSize);
        if (finalize) _finalizeAndHandOff(club, legacy, deployer);
        vm.stopBroadcast();

        console.log("Accounts listed:", legacy.accounts.length);
        console.log("Total Rep (18 decimals):", club.rep.totalSupply());
        if (finalize) {
            _requireHandedOff(club, deployer, club.timelock.GUARDIAN());
            console.log("Import finalized and deployer handed off.");
        } else {
            console.log("Verify the balances, then re-run with FINALIZE=true.");
        }
    }
}
