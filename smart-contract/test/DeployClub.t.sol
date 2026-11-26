// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClubDeployment} from "../script/ClubDeployment.sol";
import {ClubBase} from "./helpers/ClubBase.sol";

/// @dev Asserts the bootstrap order and the role matrix it must leave behind.
contract DeployClubTest is ClubBase {
    Legacy private legacy;

    function setUp() public override {
        vm.warp(START);
        legacy = _emptyLegacy();
        address[] memory holders = _sorted(alice, bob, carol);
        _legacySession(100, holders);
        _legacySession(200, _list(alice));
        legacy.sessionIds = new uint256[](2);
        (legacy.sessionIds[0], legacy.sessionIds[1]) = (100, 200);
        legacy.accounts = holders;
    }

    function deployExternal(Config memory config, Legacy memory input) external {
        _deployClub(config, input, address(this));
    }

    function finalizeExternal(Club memory deployed, Legacy memory input) external {
        _finalizeAndHandOff(deployed, input, address(this));
    }

    function requireHandedOffExternal(Club memory deployed) external view {
        _requireHandedOff(deployed, address(this), guardian);
    }

    function test_step0_freezeClosesSessionsAndStripsEveryRole() public {
        _freezeLegacy(legacy, address(this));
        assertFalse(legacyRegistry.getSession(100).active);
        assertFalse(legacyRegistry.getSession(200).active);
        for (uint256 i = 0; i < legacy.roleHolders.length; ++i) {
            address holder = legacy.roleHolders[i];
            assertFalse(legacyRegistry.hasRole(legacyRegistry.DEFAULT_ADMIN_ROLE(), holder));
            assertFalse(legacyRegistry.hasRole(legacyRegistry.ADMIN_ROLE(), holder));
            assertFalse(legacyRegistry.hasRole(legacyRegistry.RELAY_ROLE(), holder));
        }
        // History stays readable, and nothing new can be minted.
        assertEq(legacyRegistry.balanceOf(alice, 100), 1);
        vm.prank(legacyRelay);
        vm.expectRevert();
        legacyRegistry.mint(makeAddr("late"), 100);
    }

    function test_deploy_requiresAFrozenLegacyRegistry() public {
        vm.expectRevert(abi.encodeWithSelector(LegacyRoleStillHeld.selector, address(this)));
        this.deployExternal(_config(), legacy);
    }

    function test_deploy_requiresTheRoleHolderList() public {
        legacy.roleHolders = new address[](0);
        vm.expectRevert(LegacyNotListed.selector);
        this.deployExternal(_config(), legacy);
    }

    function test_deploy_rejectsAnOpenLegacySession() public {
        _freezeLegacy(legacy, address(this));
        uint256[] memory ids = legacy.sessionIds;
        // Claim a session list containing one that is still open on another registry.
        Legacy memory other = _emptyLegacy();
        _legacySession(300, _list(alice));
        other.roleHolders = new address[](1);
        other.roleHolders[0] = makeAddr("noRoles");
        ids = new uint256[](1);
        ids[0] = 300;
        other.sessionIds = ids;
        vm.expectRevert(abi.encodeWithSelector(LegacySessionStillOpen.selector, 300));
        this.deployExternal(_config(), other);
    }

    function test_deploy_rejectsGuardianOrRelayOverlap() public {
        _freezeLegacy(legacy, address(this));
        Config memory config = _config();
        config.guardian = relay;
        vm.expectRevert(BadGuardian.selector);
        this.deployExternal(config, legacy);

        config = _config();
        config.guardian = address(this);
        vm.expectRevert(BadGuardian.selector);
        this.deployExternal(config, legacy);

        config = _config();
        config.guardian = officerA;
        vm.expectRevert(BadGuardian.selector);
        this.deployExternal(config, legacy);

        config = _config();
        config.officers[1] = relay;
        vm.expectRevert(RelayIsOfficer.selector);
        this.deployExternal(config, legacy);
    }

    function test_finalize_requiresEveryAccountImported() public {
        _freezeLegacy(legacy, address(this));
        _deploy(legacy);
        vm.expectRevert(abi.encodeWithSelector(AccountNotImported.selector, legacy.accounts[0]));
        this.finalizeExternal(club, legacy);
        assertFalse(rep.importFinalized());
    }

    function test_beforeHandoff_theMatrixCheckFails() public {
        _freezeLegacy(legacy, address(this));
        _deploy(legacy);
        vm.expectRevert(abi.encodeWithSelector(HandoffIncomplete.selector, "import finalized"));
        this.requireHandedOffExternal(club);
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    function test_fullBootstrap_leavesTheExactRoleMatrix() public {
        _bootstrap(legacy);
        _requireHandedOff(club, address(this), guardian);

        // Imported from the frozen registry: alice 2 meetings, bob and carol 1.
        assertEq(rep.getVotes(alice), 20e18);
        assertEq(rep.getVotes(bob), 10e18);
        assertEq(rep.getVotes(carol), 10e18);

        address governor_ = address(governor);
        address[6] memory everyone = [address(this), governor_, guardian, relay, officerA, address(timelock)];
        bytes32 admin = timelock.DEFAULT_ADMIN_ROLE();
        bytes32 proposer = timelock.PROPOSER_ROLE();
        bytes32 canceller = timelock.CANCELLER_ROLE();
        for (uint256 i = 0; i < everyone.length; ++i) {
            address who = everyone[i];
            assertEq(timelock.hasRole(admin, who), who == address(timelock), "timelock admin");
            assertEq(timelock.hasRole(proposer, who), who == governor_, "proposer");
            assertEq(timelock.hasRole(canceller, who), who == governor_ || who == guardian, "canceller");
            assertEq(registry.hasRole(admin, who), who == address(timelock), "registry admin");
            assertEq(rep.hasRole(admin, who), who == address(timelock), "rep admin");
        }
        assertFalse(rep.hasRole(rep.MINTER_ROLE(), address(this)));
    }

    function test_import_isResumableAndBatched() public {
        _freezeLegacy(legacy, address(this));
        _deploy(legacy);
        _importLegacy(rep, legacy, 1);
        _importLegacy(rep, legacy, 2);
        _finalizeAndHandOff(club, legacy, address(this));
        assertEq(rep.totalSupply(), 40e18);
    }

    function test_defaultBatchSize_scalesWithSessionCount() public pure {
        assertEq(_defaultBatchSize(0), 100);
        assertEq(_defaultBatchSize(6), 100);
        assertEq(_defaultBatchSize(30), 20);
        assertEq(_defaultBatchSize(600), 1);
        assertEq(_defaultBatchSize(5000), 1);
    }
}
