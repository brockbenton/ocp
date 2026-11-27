// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AttendanceRegistry} from "../src/AttendanceRegistry.sol";
import {AttendanceRegistry2} from "../src/AttendanceRegistry2.sol";
import {ClubGovernor} from "../src/ClubGovernor.sol";
import {ClubRep} from "../src/ClubRep.sol";
import {ClubTimelock} from "../src/ClubTimelock.sol";

/// @notice The Phase 5 bootstrap steps, in the order they must happen:
///         freeze legacy, deploy, import, finalize, hand off. The scripts broadcast these
///         and the tests call them directly, so both run the same code.
abstract contract ClubDeployment {
    struct Config {
        address relay;
        address guardian;
        address[] officers;
        string baseCid;
        uint256 halfLife;
        uint256 timelockDelay;
        uint256 guardianTerm;
        ClubGovernor.Settings governor;
    }

    /// @dev What the legacy registry's history says (see `backend/scripts/legacy-export.ts`).
    struct Legacy {
        AttendanceRegistry registry;
        /// Every wallet that ever held a role.
        address[] roleHolders;
        /// Every session, strictly increasing.
        uint256[] sessionIds;
        /// Every wallet that holds a token.
        address[] accounts;
    }

    struct Club {
        ClubTimelock timelock;
        ClubRep rep;
        AttendanceRegistry2 registry;
        ClubGovernor governor;
    }

    /// @dev Together these keep an import tx under 10M gas: each account costs storage writes
    ///      as well as one `balanceOfBatch` read per session.
    uint256 internal constant IMPORT_READS_PER_TX = 600;
    uint256 internal constant MAX_IMPORT_ACCOUNTS_PER_TX = 75;

    error LegacyNotListed();
    error LegacyRoleStillHeld(address holder);
    error LegacySessionStillOpen(uint256 sessionId);
    error AccountNotImported(address account);
    error BadGuardian();
    error RelayIsOfficer();
    error DeployerCannotHoldRole();
    error InvalidBatchSize();
    error HandoffIncomplete(string check);

    /// @dev The defaults in the master plan. Half-life, threshold and floor are provisional.
    function _defaultSettings() internal pure returns (ClubGovernor.Settings memory) {
        return ClubGovernor.Settings({
            votingDelay: 1 days, votingPeriod: 7 days, proposalThreshold: 30e18, quorumNumerator: 10, minQuorum: 100e18
        });
    }

    // -------------------------------------------------------------------------
    // 0. Freeze the legacy registry (signed by its DEFAULT_ADMIN_ROLE holder)
    // -------------------------------------------------------------------------

    /// @param self The broadcasting wallet, which must hold the legacy admin roles.
    function _freezeLegacy(Legacy memory legacy, address self) internal {
        AttendanceRegistry registry = legacy.registry;
        bytes32 adminRole = registry.ADMIN_ROLE();
        bytes32 relayRole = registry.RELAY_ROLE();
        bytes32 defaultAdmin = registry.DEFAULT_ADMIN_ROLE();

        // Closing needs ADMIN_ROLE, so do it while the roles still exist.
        if (!registry.hasRole(adminRole, self)) registry.grantRole(adminRole, self);
        for (uint256 i = 0; i < legacy.sessionIds.length; ++i) {
            if (registry.getSession(legacy.sessionIds[i]).active) registry.closeSession(legacy.sessionIds[i]);
        }

        for (uint256 i = 0; i < legacy.roleHolders.length; ++i) {
            address holder = legacy.roleHolders[i];
            if (registry.hasRole(relayRole, holder)) registry.revokeRole(relayRole, holder);
            if (registry.hasRole(adminRole, holder)) registry.revokeRole(adminRole, holder);
            if (holder != self && registry.hasRole(defaultAdmin, holder)) {
                registry.revokeRole(defaultAdmin, holder);
            }
        }
        if (registry.hasRole(adminRole, self)) registry.revokeRole(adminRole, self);
        // Irreversible, and therefore last.
        registry.renounceRole(defaultAdmin, self);
    }

    /// @dev `AccessControl` cannot be enumerated, so the check is only as complete as the
    ///      holder list built from the registry's `RoleGranted` events.
    function _requireLegacyFrozen(Legacy memory legacy) internal view {
        AttendanceRegistry registry = legacy.registry;
        if (legacy.roleHolders.length == 0) revert LegacyNotListed();
        for (uint256 i = 0; i < legacy.roleHolders.length; ++i) {
            address holder = legacy.roleHolders[i];
            if (
                registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), holder)
                    || registry.hasRole(registry.ADMIN_ROLE(), holder)
                    || registry.hasRole(registry.RELAY_ROLE(), holder)
            ) revert LegacyRoleStillHeld(holder);
        }
        for (uint256 i = 0; i < legacy.sessionIds.length; ++i) {
            if (registry.getSession(legacy.sessionIds[i]).active) {
                revert LegacySessionStillOpen(legacy.sessionIds[i]);
            }
        }
    }

    // -------------------------------------------------------------------------
    // 1. Deploy
    // -------------------------------------------------------------------------

    /// @param deployer The broadcasting wallet: temporary Timelock admin and Rep importer.
    function _deployClub(Config memory config, Legacy memory legacy, address deployer)
        internal
        returns (Club memory club)
    {
        _requireLegacyFrozen(legacy);
        if (config.guardian == deployer || config.guardian == config.relay) revert BadGuardian();
        if (config.relay == deployer) revert DeployerCannotHoldRole();
        for (uint256 i = 0; i < config.officers.length; ++i) {
            if (config.officers[i] == deployer) revert DeployerCannotHoldRole();
            if (config.officers[i] == config.relay) revert RelayIsOfficer();
            if (config.officers[i] == config.guardian) revert BadGuardian();
        }

        address[] memory noProposers = new address[](0);
        address[] memory anyoneExecutes = new address[](1);
        club.timelock = new ClubTimelock(
            config.timelockDelay,
            noProposers,
            anyoneExecutes,
            deployer,
            config.guardian,
            block.timestamp + config.guardianTerm
        );
        club.rep = new ClubRep(address(club.timelock), address(legacy.registry), deployer, config.halfLife);
        club.registry = new AttendanceRegistry2(
            address(club.timelock), address(club.rep), config.officers, config.relay, config.baseCid
        );
        club.rep.setRegistry(address(club.registry));
        club.governor = new ClubGovernor(club.rep, club.timelock, config.governor);
        club.timelock.grantRole(club.timelock.PROPOSER_ROLE(), address(club.governor));
        club.timelock.grantRole(club.timelock.CANCELLER_ROLE(), address(club.governor));
    }

    // -------------------------------------------------------------------------
    // 2. Import
    // -------------------------------------------------------------------------

    function _defaultBatchSize(uint256 sessionCount) internal pure returns (uint256) {
        uint256 size = IMPORT_READS_PER_TX / (sessionCount == 0 ? 1 : sessionCount);
        if (size == 0) return 1;
        return size > MAX_IMPORT_ACCOUNTS_PER_TX ? MAX_IMPORT_ACCOUNTS_PER_TX : size;
    }

    /// @notice Imports every listed account not yet imported, so it can be re-run.
    function _importLegacy(ClubRep rep, Legacy memory legacy, uint256 batchSize) internal {
        if (batchSize == 0) revert InvalidBatchSize();
        address[] memory pending = new address[](legacy.accounts.length);
        uint256 count = 0;
        for (uint256 i = 0; i < legacy.accounts.length; ++i) {
            if (!rep.isImported(legacy.accounts[i])) pending[count++] = legacy.accounts[i];
        }
        for (uint256 start = 0; start < count; start += batchSize) {
            uint256 size = count - start < batchSize ? count - start : batchSize;
            address[] memory batch = new address[](size);
            for (uint256 i = 0; i < size; ++i) {
                batch[i] = pending[start + i];
            }
            rep.importLegacy(batch, legacy.sessionIds);
        }
    }

    // -------------------------------------------------------------------------
    // 3. Finalize and hand off
    // -------------------------------------------------------------------------

    function _finalizeAndHandOff(Club memory club, Legacy memory legacy, address deployer) internal {
        _requireLegacyFrozen(legacy);
        for (uint256 i = 0; i < legacy.accounts.length; ++i) {
            if (!club.rep.isImported(legacy.accounts[i])) revert AccountNotImported(legacy.accounts[i]);
        }
        club.rep.finalizeImport();
        club.timelock.renounceRole(club.timelock.DEFAULT_ADMIN_ROLE(), deployer);
    }

    /// @notice Asserts the post-handoff role matrix.
    function _requireHandedOff(Club memory club, address deployer, address guardian) internal view {
        ClubTimelock timelock = club.timelock;
        bytes32 admin = timelock.DEFAULT_ADMIN_ROLE();
        bytes32 proposer = timelock.PROPOSER_ROLE();
        bytes32 canceller = timelock.CANCELLER_ROLE();
        bytes32 executor = timelock.EXECUTOR_ROLE();
        address governor = address(club.governor);

        _check(club.rep.importFinalized(), "import finalized");
        _check(!timelock.hasRole(admin, deployer), "deployer is not Timelock admin");
        _check(!timelock.hasRole(proposer, deployer), "deployer cannot propose");
        _check(!timelock.hasRole(canceller, deployer), "deployer cannot cancel");
        _check(!club.registry.hasRole(admin, deployer), "deployer is not registry admin");
        _check(!club.registry.hasRole(club.registry.ADMIN_ROLE(), deployer), "deployer is not an officer");
        _check(!club.registry.hasRole(club.registry.RELAY_ROLE(), deployer), "deployer is not the relay");
        _check(!club.rep.hasRole(admin, deployer), "deployer is not Rep admin");
        _check(timelock.hasRole(admin, address(timelock)), "Timelock administers itself");
        _check(club.registry.hasRole(admin, address(timelock)), "Timelock administers registry");
        _check(club.rep.hasRole(admin, address(timelock)), "Timelock administers Rep");
        _check(timelock.hasRole(proposer, governor), "Governor proposes");
        _check(timelock.hasRole(canceller, governor), "Governor cancels");
        _check(timelock.hasRole(canceller, guardian), "guardian cancels");
        _check(!timelock.hasRole(proposer, guardian), "guardian cannot propose");
        _check(timelock.hasRole(executor, address(0)), "anyone executes");
        _check(club.rep.hasRole(club.rep.MINTER_ROLE(), address(club.registry)), "registry mints Rep");
    }

    function _check(bool ok, string memory what) private pure {
        if (!ok) revert HandoffIncomplete(what);
    }
}
