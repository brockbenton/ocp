# Smart contracts

Built with [Foundry](https://book.getfoundry.sh/) for Base. Conventions are in [CLAUDE.md](CLAUDE.md); the design is in [the master plan](../MASTER_PLAN.md#phase-5--club-dao-v1-our-club).

- `AttendanceRegistry`: the deployed soulbound ERC-1155 attendance registry.
- `AttendanceRegistry2`, `ClubRep`, `ClubGovernor`, `ClubTimelock`: the Phase 5 club DAO. Implemented and tested, **not deployed or audited**.

```shell
forge build
forge test
forge build --sizes --skip test --skip script
forge fmt
```

Deployment steps are in [`DEPLOY.md`](DEPLOY.md).
