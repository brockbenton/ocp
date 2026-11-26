# Security — Onchain Club Protocol (OCP)

A single running inventory of every security feature, known gap, and accepted risk in OCP. Keep it current: when a feature ships, changes, or a decision is made, update the row and the [decision log](#decision-log).

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's **Security → Report a vulnerability** (private advisory) on this repo.

## Security review guidelines (for human and AI reviewers)

When reviewing a PR, check it against the inventory below and flag:

1. **Weakened or removed protections:** any ✅ Live item made weaker, or a 🟡 v1 item implemented differently from what's described here without updating this file.
2. **Key and role changes:** new private keys, new on-chain roles, or wider powers for an existing key. Update §2 with what the key can do if leaked.
3. **Rep / voting power:** any attendance credit without two-officer approval, duplicate or non-AT-holder awards, transfers/delegation, or departure from the full 10 nominal Rep award and gradual-decay rules. Verify historical account/total power, fixed proposal snapshots and consistent rounding. Do not reintroduce retired supply-based session reductions, weekly Rep caps/budgets or deferred claims without an explicit new design decision.
4. **Signatures:** signed messages without `chainId` + contract binding, a nonce, or an expiry; replay across sessions, contracts, or chains.
5. **AuthZ:** officer/admin checks that aren't read live from the chain, that fail open on RPC errors, or that trust client-supplied addresses.
6. **Privacy:** PII (email, linked accounts) on any unauthenticated endpoint.
7. **Contracts:** violations of `smart-contract/CLAUDE.md` (upgradeable proxies, `tx.origin`, `block.timestamp` in access control, unbounded governance parameters, transfers of soulbound tokens or Rep).
8. **This file:** if the PR changes security behavior, it must update the matching row and the decision log.

**Status legend**

| Tag | Meaning |
|---|---|
| ✅ **Live** | Implemented on `master` today |
| 🟡 **v1** | Planned for Phase 5 — Club DAO v1 (our club). Issue linked. |
| 🔧 **Built** | Implemented and tested in this repo for Phase 5; **not deployed or audited**. |
| 🔵 **v2** | Deferred to Phase 6 — multi-club / v2 governance |
| ⚠️ **Gap** | Known weakness in the live system, not yet fixed |
| 📝 **Accepted** | Residual risk we've knowingly accepted |

Design source of truth: `MASTER_PLAN.md` → Phase 5 + Security Considerations (PR #45). Review findings are tracked in issue #77. **Current policy is Revision 3.3 (2026-11-03): participation-earned Rep with gradual decay is required in v1.** This security PR and PR #45 must land together for the complete design; planned protections below are not live guarantees.

---

## 1. Trust model at a glance

| Party | Trusted for | Cannot do (by design) |
|---|---|---|
| **Members** | Their own check-ins and votes | Transfer tokens or Rep; vote with someone else's power |
| **Officers** (`ADMIN_ROLE`) | Running sessions, setting attendee counts, confirming eligible attendees | Role changes require governance approval and Timelock execution; officers must not grant/revoke directly. The backend has no route or key that changes roles (#82). ⚠️ The legacy registry still lets the `DEFAULT_ADMIN_ROLE` holder change roles without a vote until it is frozen. 🟡 v1: one officer cannot create attendance Rep alone; officer count cannot fall below 2. Two colluding officers can approve repeated fake sessions: **no aggregate issuance-rate bound**. |
| **Backend + relay** | Verifying check-ins (attendance is attested **off-chain**), paying gas, submitting signed votes | 🟡 v1: create Rep, forge votes, change roles or parameters |
| **Governance** (Governor + Timelock) | Roles, parameters, officer elections, Rep grants/revokes | 🟡 v1: remove its own admin role; set parameters outside on-chain bounds |
| **Guardian** (Safe, bootstrap only) | Vetoing (cancelling) malicious proposals during bootstrap | 🟡 v1: propose or execute anything; keep the veto past 120 days |

> 📝 **Core accepted risk:** whether someone was physically in the room is decided off-chain (QR + backend + officers). On-chain checks enforce per-session counts and distinct-officer approval; they cannot prove presence or cap issuance across repeated sessions. Gradual decay is not Sybil resistance or protection against fresh fraudulent Rep.

---

## 2. Keys and roles

### Backend keys (Phase 5 code; deploy with the Phase 5 contracts)

| Key (backend env) | On-chain role | Used for | If leaked |
|---|---|---|---|
| `RELAY_PRIVATE_KEY` | `RELAY_ROLE` only | Mints attendance tokens; pays gas for Rep credit pages and members' signed votes | Mint tokens into **open** sessions up to each cap; drain the relay's gas balance. Cannot create Rep or forge votes ⚠️ |
| `QR_SIGNER_PRIVATE_KEY` | **none** | Signs QR payloads. One per environment | Forge QR codes for open sessions; useful only with the relay, still bounded by caps and two-officer review |

- ✅ All keys live only in backend env vars — never shipped to the frontend.
- ✅ The server refuses to start if the QR key holds any role, or the relay holds anything beyond `RELAY_ROLE` (`lib/keyChecks.ts`) (#55).
- ✅ The backend reads no admin or officer key: `ADMIN_SIGNER_PRIVATE_KEY` and `DEFAULT_ADMIN_PRIVATE_KEY` are gone (#55, #82).
- ⚠️ Deployments still running the earlier backend use `ADMIN_SIGNER_PRIVATE_KEY` (`ADMIN_ROLE` on the legacy registry). At cutover, delete it and any `DEFAULT_ADMIN_PRIVATE_KEY` from every environment, freeze the legacy registry and record the transaction hashes (#55, #82).

### v1 target (Phase 5)

| Holder | Role | Notes |
|---|---|---|
| Timelock | `DEFAULT_ADMIN_ROLE` on registry + Rep | 🟡 Non-revocable / non-transferable — governance can't lock itself out |
| Officers (min 2) | `ADMIN_ROLE` | 🟡 Send their own txs from Privy embedded wallets funded with a little Base ETH |
| Relay | `RELAY_ROLE` | 🟡 Mints attendance tokens only; Rep is never minted by the relay |
| QR signer | **no role** | 🟡 New key per environment, signs QR payloads only (#55) |
| Guardian Safe | Timelock `CANCELLER` only | 🟡 Veto during bootstrap; anyone can expire it after 120 days |
| Deployer | temporary Timelock admin | 🟡 Grants Governor roles, then renounces everything; test asserts it holds nothing (#62) |

- ✅ `DEFAULT_ADMIN_PRIVATE_KEY` and its code paths are removed from the backend (#55)
- 🟡 Freeze the legacy registry: close all sessions, revoke relay + admin roles, renounce default admin (#51, #55)

---

## 3. Identity and authentication

| Feature | Status | Details |
|---|---|---|
| Social / passkey login with embedded wallet | ✅ | Privy: email, Google, passkey. Every login gets a wallet — no MetaMask needed |
| Server-side token verification | ✅ | `authMiddleware` verifies the Privy ID token on every authed request (`backend/src/middleware/auth.ts`) |
| Requests without a wallet rejected | ✅ | `403 NO_WALLET` when the account has no embedded wallet |
| Wedged-session self-heal | ✅ | `SessionRecoveryGate` recovers a stuck Privy session once per tab |
| Identity pinned to the embedded wallet | ✅ | Identity is the Privy embedded wallet stored on the member record (or the primary embedded wallet before one exists). Linked external wallets are never identities; an account with none gets `403 NO_WALLET` (#74) |
| Never enable Privy delegated actions / session signers | ✅ rule | Hard rule — otherwise the backend *could* sign votes for members. A frontend test fails on delegated-action or session-signer APIs and on hidden confirmations (#70) |
| Readable signing prompts | 🔧 | The app shows the proposal title and For/Against/Abstain before the prompt, and the prompt repeats them; confirmations are forced on. V1 uses stock `castVoteBySig`, so the signed fields themselves are an id and a number. Needs manual QA on Sepolia (#70) |
| Sybil resistance | ⚠️ / 🔵 | Nothing stops one person holding several accounts. v1 relies on attendee verification, two-officer sign-off and anomaly monitoring, **not** weekly Rep budgets or decay. `.edu` gating (one inbox, not one person) is v2 (#50, #71) |

---

## 4. Check-in anti-cheat

| Feature | Status | Details |
|---|---|---|
| Admin-signed QR payload | ✅ | EIP-712 `CheckInQR{sessionId, issuedAt, expiresAt, nonce}` signed by the QR key; verified server-side (`qr.service.ts`) |
| QR expiry | ✅ | Each QR is valid for 5 minutes (`QR_TTL_MS`, which can only shorten it). The projector page fetches a replacement 90 s before expiry, keeps the current code up while retrying, and never shows an expired one (#72) |
| Member signature bound to their wallet | ✅ | Member signs EIP-712 `CheckIn{sessionId, member, signedAt}`; the recovered address must equal the authenticated embedded wallet |
| Stale-signature window | ✅ | Member signature must be ≤ 60 s old and ≤ 10 s in the future |
| One check-in per member per session | ✅ | DB `@@unique([memberId, sessionId])` **and** the contract's one-token-per-session rule |
| Session must be open and confirmed on-chain | ✅ | Closed or unconfirmed sessions rejected |
| Per-user rate limit | ✅ | 30 check-in attempts/min keyed by Privy user, not IP (a whole room shares one wifi IP) |
| QR + check-in signatures bound to chain + contract | ✅ | Both use the EIP-712 domain `{name: "OCP Check-In", version: "1", chainId, verifyingContract: registry}`, so neither replays across chains or registries. Sessions are unique on `(registryAddress, sessionIdOnchain)` and only looked up that way (#56) |
| Officer-set max attendance per session | 🔧 | Set at `createSession` (the UI pre-fills a suggestion); enforced on-chain for minting and refused early by the API (#50) |
| Open-session warning | 🔧 | Officers are alerted once, and the dashboard lists sessions open longer than `OPEN_SESSION_WARN_HOURS` (default 6). A nudge only: sessions never auto-close |
| No time limits on creating sessions / QR codes | 🟡 decided | Officers can start a session any time; protection relies on attendee caps and two-officer review; no aggregate Rep issuance-rate limit |

> ⚠️ A photo of the QR shared in a group chat works remotely until it expires (5 min once #72 ships). Mitigated by `maxAttendees`, two-officer attendee review and anomaly alerts. There is no club-wide weekly Rep budget; decay does not verify presence.

---

## 5. Rep (voting power) protection — v1

Attendance tokens and Rep are separate: tokens mint instantly as a record; **Rep gains voting power only after two officers approve and the recipient's credit page lands.** Each verified eligible attendance earns 10 nominal Rep; current influence gradually decays while lifetime attendance/ATs remain permanent.

| Feature | Status | Details |
|---|---|---|
| Rep is soulbound | 🔧 | Decay-aware `IVotes`, no transfer/approve surface or usable delegation; each account is its own delegate. Ordinary OZ `Votes` checkpoints do not decay automatically (#68) |
| Rep pending until a second officer confirms | 🔧 | Officer A closes with the sorted unique AT-holder list → Pending (zero power). A different officer B (or Timelock) confirms, fixing one recognition timestamp; anyone credits sequential pages. Pending never expires; any officer can reject while Pending. Empty lists complete without credit (#50) |
| Rep only for real token holders | 🔧 | Only listed addresses that hold that session's attendance token are credited, at most `maxAttendees` |
| Full attendance award | 🔧 | **10 nominal Rep per eligible attendance**, no pro-rata reduction or supply-dependent award. A 300-attendee session awards 3,000 nominal Rep. No per-member weekly cap, club-wide weekly budget or deferred claims (#50) |
| Gradual Rep decay | 🔧 | `r × 2^(-(t-t0)/H)`; **180-day half-life provisional** for 5a validation, immutable per deployment. No officer/keeper-triggered epoch rollover or semester reset; new credit does not refresh old Rep (#61, #68) |
| Historical vote weights and totals | 🔧 | Decay-aware account and total power at timestamp t; fixed proposal snapshot for weight/quorum. Later decay, credits and revokes never rewrite old snapshots. Consistent fixed-point units/rounding; bounded historical reads (#61, #68) |
| Delayed page credit | 🔧 | Decay measured from the session's common recognition time, no power before the page lands and no retroactive checkpoint. Hash/cursor prevent double-credit. Blocked recipients skip-and-emit without stalling others (#50, #68) |
| Minimum 2 officers | 🔧 | Enforced in `_revokeRole` (covers revoke + renounce); election templates grant the new officer before revoking the old (#60) |
| Relay can't create Rep | 🔧 | A leaked relay key can only mint attendance tokens, which carry no Rep |
| Mint pause | 🔧 | Any officer can pause minting; auto-expires after 14 days; each officer may pause once per 30 days; unpause by 2 officers or the Timelock (#52) |
| Governance Rep revoke | 🔧 | Timelock removes remaining decayed power and blocks new credit until cleared; historical snapshots stay unchanged. Grants decay from execution and record a reason (#68) |
| Anomaly alerts | 🔧 | The review queue flags unusually high attendance, many first-time, new or unknown wallets, lists that differ from recorded check-ins, and repeated sessions; officers are alerted (dashboard, log, optional webhook). Flags are advice, not enforcement. Attendee lists are public at `/api/v1/club/sessions` (#50) |
| Legacy Rep import is computed on-chain | 🔧 | Derive nominal Rep on-chain from closed sessions in the frozen legacy registry, at most 10× legacy ATs. All import batches share a deployment-fixed recognition time, then decay. No proposals until finalized (#51) |

> ⚠️ **Changed threat model — review before deployment:** two colluding officers can approve repeated fabricated sessions, creating fresh Rep with **no weekly issuance-rate bound**. Decay does not prevent capture before governance removes them. Governance revoke/removal depend on honest governance still having control. Mint pause does not block existing Pending confirmations; two colluders can unpause each other. Do not carry forward the old "up to the weekly budget" guarantee (#50).
> 🟡 **Decay is required in v1:** inactive influence fades, AT history stays permanent. Validate the half-life, fixed-point precision, and proposal recovery after long inactivity before deployment (#52, #61, #68).

---

## 6. Smart contracts

| Feature | Status | Details |
|---|---|---|
| Soulbound attendance tokens | ✅ | `_update` reverts on any transfer (`from != 0`); `setApprovalForAll` reverts |
| Role-based access control | ✅ | OpenZeppelin `AccessControl`: `DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`, `RELAY_ROLE` |
| Re-entrancy guard on mint | ✅ | `nonReentrant` |
| Custom errors, events for every state change | ✅ | `SessionNotActive`, `AlreadyCheckedIn`, `Soulbound`, … |
| No upgradeable proxies, no `tx.origin`, no `selfdestruct` | ✅ | Enforced by `smart-contract/CLAUDE.md` |
| Optimizer on + bytecode size check | 🔧 | `optimizer = true`, 200 runs; `forge build --sizes` on every contract (#54) |
| Bounded governance parameters | 🔧 | Voting delay 1 h–7 d · voting period 3–14 d · Timelock delay 1–7 d · quorum 5–30% · proposal threshold 10–1,000 Rep (#66) |
| Snapshot quorum and inactivity recovery | 🔧 | `max(numerator × supply(t), min(minQuorum, 50% × supply(t)))` uses **decayed snapshot supply**. Positive-supply floor is clamped, but proposal-threshold recovery and zero/dust supply behavior must be resolved/tested before deploy (#52, #61) |
| Timelock roles exact | 🔧 | Governor = proposer + canceller; guardian = canceller only (bootstrap); deployer renounces (#62) |
| Timestamp use | 🔧 | Allowed for gradual decay, recognition timestamps, ERC-6372 clock, pause/guardian expiry and durations; never caller authorization. No weekly Rep buckets or officer-controlled epoch rollover |
| Mint without receiver hook; batch skips duplicates | 🔧 | One bad recipient can't revert a whole batch (#59) |
| Paginated Rep crediting | 🔧 | Close stores list hash; full 10 nominal Rep is credited in sequential pages with common recognition time. Gas tests hold every transaction under 10M, including blocked recipients and long inactivity (#50, #68, #75) |
| Governor timelock fixed | 🔧 | `updateTimelock` reverts: the registry and Rep admin is permanently the original Timelock |
| Self-revocation of Governor roles | 📝 | A passed proposal could remove the Governor's Timelock roles and end governance. Open for the audit |

---

## 7. Relay and transactions

| Feature | Status | Details |
|---|---|---|
| Gasless for members | ✅ | Backend wallet pays all mint gas |
| Database-backed relay queue | 🔧 | Work and nonces are rows in PostgreSQL; check-ins are coalesced into `mintBatch`; bounded retries end in `FAILED` with a reason (#59) |
| Single relay sender | 🔧 | One backend instance; a unique key per nonce prevents double use |
| Gasless voting | 🟡 | Members sign `castVoteBySig`; relay submits; **anyone** can submit a signed vote. Relay cannot forge it, but can censor its own submissions; independent verification and a funded fallback are needed (#58) |
| Censorship check from the frontend | 🔧 | The browser reads `hasVoted` over public RPC, not via the backend. After 60 s or a relay refusal it hands the member the signed vote to submit themselves or give an officer, who verifies and submits it from the app (#58) |
| One tx per relayed vote (no Multicall) | 🔧 | One bad vote can't revert others. The API accepts a vote only from its signer, with voting power, after simulating it; rate limited (#59) |
| Nonce manager with stuck-tx replacement | 🔧 | Fee bump or cancel of the oldest stuck transaction, capped by `RELAY_MAX_FEE_GWEI`; `SUBMITTED` until `CONFIRMATIONS` blocks deep. Tested against a local node (#59) |
| Relay key rotation runbook | 🟡 | Pause → governance rotates `RELAY_ROLE` (#52) |
| Sessions stay mintable while open | ⚠️ / 📝 | A leaked relay key can mint tokens into open sessions; once v1 ships those carry no Rep (cosmetic) |

---

## 8. Backend API

| Feature | Status | Details |
|---|---|---|
| Zod validation on request bodies | ✅ | `validate()` middleware |
| Uniform error format, no stack traces | ✅ | Global error handler returns `{ error: { code, message } }` |
| Async errors reach the error handler | ✅ | `express-async-errors` |
| Officer auth checks the chain, fails closed | ✅ | `adminMiddleware` reads on-chain `ADMIN_ROLE` on every request; RPC failure → `503`, not access (`backend/src/middleware/admin.ts`) |
| Governance-only role changes | 🔧 | The API has no route or key that changes roles; officers are read live from the registry. On-chain, only the Timelock can grant or revoke (#82, #55) |
| Live officer checks stay live | ✅ | The authoritative officer source is the registry's on-chain `hasRole(ADMIN_ROLE)`, read on every session, QR, export and PII request with no cache, so a revoked officer loses access on their next request. RPC failure fails closed (#69) |
| CORS | ✅ | Exact-match origin allowlist from `CORS_ORIGINS` (required at startup); methods `GET, POST, PATCH, DELETE` and headers `Authorization, Content-Type` only (#80) |
| Security headers | ✅ | `helmet` on the API: `default-src 'none'; frame-ancestors 'none'`, HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; no `X-Powered-By`. Only the public SVG art routes are cross-origin embeddable (#81) |
| Structured logging | ✅ | pino; no `console.log` |

---

## 9. Data and privacy

| Feature | Status | Details |
|---|---|---|
| No PII on public endpoints | ✅ | Public `GET /members` strips `linkedAccount` (email/social) and internal ids; PII only behind the admin gate |
| Wallet address as public identity | ✅ | Vault/stats are public by address, with no PII |
| Per-club PII scoping | 🔵 | Needed once there are multiple clubs (#57) |
| Secrets only in env vars | ✅ | Never committed; `.env.example` holds placeholders only |

---

## 10. Governance (v1)

| Feature | Status | Details |
|---|---|---|
| On-chain voting with Rep | 🟡 | OZ Governor + Timelock reading decay-aware IVotes. Member signatures are relayed; weight/quorum fixed at proposal snapshot, independent of later decay (#61, #68) |
| Officer elections via proposals | 🟡 | All role grants and revocations require approved governance proposals and Timelock execution; no direct officer or backend-signer bypass (#82). Proposals call `grantRole` / `revokeRole(ADMIN_ROLE)`; one semester per term by convention. Approval-voting elections contract is v2 (#53) |
| Proposing needs gas | 🟡 | Officers (and funded members) propose directly; gasless proposals are v2 (#63) |
| Timelock delay on every change | 🟡 | 1–7 days (bounded) so members can react to a bad proposal |
| Guardian veto during bootstrap | 🟡 | Cancel-only; renounced after the first election or expired after 120 days |

---

## 11. Frontend

| Feature | Status | Details |
|---|---|---|
| No secrets in the client | ✅ | Only `NEXT_PUBLIC_*` values (Privy app id, API URL) |
| Security headers | ✅ | `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera for this origin only). No script/connect CSP, so Privy keeps working (#81) |
| Fail fast without Privy config | ✅ | `next.config.mjs` fails dev and build when `NEXT_PUBLIC_PRIVY_APP_ID` is missing (#49) |
| Current influence and permanent history | 🔧 | Shows pending approval, awaiting credit and current Rep with the time it was read, re-read while open; lifetime attendance is separate. No weekly or deferred states (#61, #68) |
| Proposal integrity | 🔧 | Actions are decoded from calldata in the browser, and the proposal is checked against its on-chain id before any vote can be signed |
| Metadata preview before signing | 🔧 | Officers see a meeting's token metadata and CID before signing `createSession` (#74) |

---

## 12. Operations

| Item | Status | Details |
|---|---|---|
| CI: contract tests, backend build+test, frontend build+typecheck | ✅ | `.github/workflows/ci.yml` |
| Testnet first | ✅ | Base Sepolia; mainnet only after a pilot semester + audit |
| Relay balance monitoring | 🔧 | Warns below `RELAY_MIN_BALANCE_ETH`; top-up and incident runbook in `smart-contract/DEPLOY.md` (#73 for per-club budgets in v2) |
| Officer wallet funding | 🟡 | Small Base ETH per officer; who funds it is an open decision |
| Audits | 🟡 | `contract-auditor` + `security-reviewer` on the 5a code; external audit before mainnet |

---

## Open security decisions

- Guardian Safe signers
- Who funds officer wallets, and how much
- Validate provisional 180-day half-life and fixed-point precision/rounding during 5a; immutable per deployment
- Validate provisional proposal threshold 30 Rep and minQuorum 100 Rep; define recovery when everyone falls below threshold, and zero/dust-supply behavior **before deployment** (#52, #61, #68). Current behavior is recorded in `MASTER_PLAN.md` → 5a implementation record
- Review repeated-session officer collusion without aggregate Rep issuance limits; decay is not an anti-farming control (#50)
- Verify historical indexer/Tally compatibility on a testnet deployment (#68). Bounded gas after long inactivity is tested (#75)

---

## Decision log

| Date | Decision |
|---|---|
| 2026-11-02 | Pivot to a DAO: soulbound Rep from attendance, on-chain voting, officer elections; only members + officers |
| 2026-11-03 | v1 = our club only; multi-club and approval elections → v2. Earlier deferral of Rep decay is **superseded by Revision 3.3 below**. |
| 2026-11-03 | Rep requires two-officer sign-off; pending Rep has no voting power |
| 2026-11-03 | No time limits on creating sessions / QR codes |
| 2026-11-03 | QR codes valid for 5 minutes |
| 2026-11-03 | Officer sets max attendance per session; minimum 2 officers |
| 2026-11-03 | **Historical, superseded:** supply-based session cap, per-member weekly cap, club-wide weekly budget and deferred claims from Revision 3.1/3.2 are removed by Revision 3.3. |
| 2026-11-03 | Dashboard warning for sessions left open (no auto-close) |
| 2026-11-03 | All role grants and revocations require governance approval and Timelock execution; officers must not change roles directly. Existing backend default-admin bypass and deployment key audit tracked in #82; retirement in #55 |
| 2026-11-03 | **Revision 3.3 (owner): Colony-inspired participation reputation in v1.** Full 10 nominal Rep per verified eligible attendance after two-officer approval; gradual decay; fixed vote snapshots; permanent AT/lifetime history. No supply-based session reductions, weekly Rep caps/budgets or deferred claims. Half-life 180 days is provisional, not a final numeric policy. Treasury/gas budgets are separate. Review collusion and inactivity-recovery implications before deployment. |
