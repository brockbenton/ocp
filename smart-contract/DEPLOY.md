Full deployment pipeline for the AttendanceRegistry contract. Walk through every step in order. Do not skip steps. Confirm the target network before any on-chain action.

---

**Step 0 — Confirm target network**
Ask: "Deploying to Base Sepolia (testnet) or Base Mainnet? Type 'sepolia' or 'mainnet'."
Wait for confirmation before proceeding. If mainnet, add an extra warning.

---

**Step 1 — Pre-flight checks**
```bash
cd smart-contract
forge build
```
Build must pass with zero errors and zero warnings. If it fails, stop and report errors.

```bash
forge test -vv
```
All tests must pass. If any fail, stop. Do not deploy with failing tests.

---

**Step 2 — Verify environment**
Check that the following env vars are set in `smart-contract/.env`:
- `PRIVATE_KEY` — deployer wallet
- `ALCHEMY_API_KEY` — Base RPC
- `BASESCAN_API_KEY` — for contract verification

If any are missing, stop and list what's needed.

---

**Step 3 — Deploy**

For Base Sepolia:
```bash
forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY \
  -vvv
```

For Base Mainnet:
```bash
forge script script/Deploy.s.sol \
  --rpc-url https://mainnet.base.org \
  --broadcast \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY \
  -vvv
```

Record the deployed contract address from the output.

---

**Step 4 — Grant roles**
After deployment, the deployer holds `DEFAULT_ADMIN_ROLE`. Grant the required roles:

```bash
# Grant RELAY_ROLE to the backend relay wallet
cast send <CONTRACT_ADDRESS> \
  "grantRole(bytes32,address)" \
  $(cast keccak "RELAY_ROLE") \
  <RELAY_WALLET_ADDRESS> \
  --rpc-url <RPC_URL> \
  --private-key $PRIVATE_KEY

# Grant ADMIN_ROLE to each admin wallet
cast send <CONTRACT_ADDRESS> \
  "grantRole(bytes32,address)" \
  $(cast keccak "ADMIN_ROLE") \
  <ADMIN_WALLET_ADDRESS> \
  --rpc-url <RPC_URL> \
  --private-key $PRIVATE_KEY
```

Confirm each transaction succeeds. Verify roles are set:
```bash
cast call <CONTRACT_ADDRESS> \
  "hasRole(bytes32,address)" \
  $(cast keccak "RELAY_ROLE") \
  <RELAY_WALLET_ADDRESS> \
  --rpc-url <RPC_URL>
```

---

**Step 5 — Update addresses.json**
Write the deployed address to `addresses.json` at the project root:
```json
{
  "AttendanceRegistry": {
    "sepolia": "<address or null>",
    "mainnet": "<address or null>"
  }
}
```

---

**Step 6 — Sync ABI**
Run `/sync-abi` to propagate the newly compiled ABI to frontend and backend.

---

**Step 7 — Update environment variables**
Remind the user to update:
- `backend/.env`: `CONTRACT_ADDRESS=<new address>`
- `frontend/.env.local`: `NEXT_PUBLIC_CONTRACT_ADDRESS=<new address>`

---

**Step 8 — Verify on Basescan**
Provide the Basescan link:
- Sepolia: `https://sepolia.basescan.org/address/<address>`
- Mainnet: `https://basescan.org/address/<address>`

Confirm the contract is verified (source code visible). If verification failed during deploy, run:
```bash
forge verify-contract <address> AttendanceRegistry \
  --chain base-sepolia \
  --etherscan-api-key $BASESCAN_API_KEY
```

---

**Final report:**
- Contract address
- Network
- Roles granted (relay wallet, admin wallets)
- Basescan link
- Any issues encountered

---

## Role changes and base CID (legacy registry)

The backend holds no `DEFAULT_ADMIN_ROLE` key and has no route that changes roles (#82). Until
the Phase 5 governance contracts are live, whoever holds `DEFAULT_ADMIN_ROLE` makes these changes
from their own machine, never from a server. Use a hardware wallet or an encrypted Foundry
keystore (`cast wallet import`), not a raw key on the command line.

```bash
# Grant or revoke an officer (use revokeRole to remove one)
cast send <CONTRACT_ADDRESS> "grantRole(bytes32,address)" $(cast keccak "ADMIN_ROLE") <WALLET> \
  --rpc-url <RPC_URL> --account <keystore-name>

# Apply the base CID returned by "publish metadata"
cast send <CONTRACT_ADDRESS> "setBaseCid(string)" <CID> \
  --rpc-url <RPC_URL> --account <keystore-name>
```

After `setBaseCid`, set `CONTRACT_BASE_CID` on the backend to the same CID and restart it: the
API builds metadata URIs from that variable, not from the contract.

---

## Phase 5 club DAO bootstrap

> Not yet run on any public network. Do not run it before the review gates in the master plan
> (collusion threat model, half-life and governance parameters, inactivity recovery, audit) are
> signed off. Mainnet needs an explicit owner go-ahead.

Sign with an encrypted keystore (`--account <name>`). Variables are listed in `.env.example`.
Order matters; each script refuses to run if the step before it is incomplete.

1. **Export legacy history** (read-only):
   `cd backend && npx tsx scripts/legacy-export.ts <rpc-url> <legacy-registry> <deploy-block> ../smart-contract/data/legacy.json`.
   Review the role holders, sessions and accounts it lists. The freeze and import checks are only
   as complete as this file.
2. **Freeze the legacy registry** (IRREVERSIBLE; signed by its `DEFAULT_ADMIN_ROLE` wallet). Stop
   the old backend first, since it can no longer mint or create sessions afterwards:
   `forge script script/FreezeLegacy.s.sol --rpc-url <RPC> --account <legacy-admin> --broadcast --slow`
3. **Deploy** (`RELAY_WALLET`, `GUARDIAN_SAFE`, `OFFICERS`, `BASE_CID`):
   `forge script script/DeployClub.s.sol --rpc-url <RPC> --account <deployer> --broadcast --slow --verify`
4. **Import** with the printed `CLUB_*` addresses:
   `forge script script/ImportLegacy.s.sol --rpc-url <RPC> --account <deployer> --broadcast --slow`
   Check a sample of balances: each is 10 Rep per legacy token, decayed from the deploy time.
   Re-running skips imported accounts.
5. **Finalize and hand off** (IRREVERSIBLE): run step 4 again with `FINALIZE=true`. The script
   asserts that the deployer holds no role and prints confirmation. Proposals are rejected until
   this has happened.
6. Record the addresses in `addresses.json`, then update the backend and frontend environment.
7. After the first officer-election proposal executes, the guardian renounces `CANCELLER_ROLE`.
   After 120 days anyone can call `ClubTimelock.expireGuardian()`.

## Incident runbook (Phase 5)

- **Relay key leaked:** any officer calls `pauseMinting()` (14 days, once per officer per 30
  days). Reject affected Pending sessions with `rejectSessionRep`. Pass a proposal revoking and
  granting `RELAY_ROLE`; delay (1 day) + vote (7 days) + Timelock (2 days) fits inside one pause.
  Pause does **not** block confirmation or credit of sessions already Pending.
- **Backend censoring or down:** votes can be submitted by anyone. A member copies the signed
  vote from the app and an officer submits it with their funded wallet
  (`castVoteBySig(proposalId, support, voter, signature)`).
- **Wrongly awarded Rep:** a proposal calls `ClubRep.revoke(account, reasonURI)`; `unblock`
  lets the account earn again (revoked Rep is not restored).
- **Officer lost or compromised:** a proposal grants the replacement first, then revokes. The
  registry never allows fewer than two officers.
- **Limits:** two colluding officers can unpause each other, and governance captured with
  fraudulent Rep can defeat a removal. See `SECURITY.md`.
- **Wallet funding:** officers and the relay each need a little Base ETH. Keep the relay
  balance small; the backend warns below `RELAY_MIN_BALANCE_ETH`. Top up from a cold wallet.
