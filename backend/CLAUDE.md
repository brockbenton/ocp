# Backend — Rules & Conventions

## Phase 5 (club DAO)

Follow `../MASTER_PLAN.md`. Officers act from their own wallets; the backend mirrors the
chain, signs QR codes and runs one relay that mints tokens, credits confirmed Rep and
submits members' signed votes. It holds no officer or admin power.

## Stack
- **Node.js** + **Express** + **TypeScript** (strict)
- **PostgreSQL** + **Prisma ORM** — all DB access through Prisma client
- **Alchemy** (or any RPC) — Base, used through viem
- **viem** — contract interaction, signing, encoding (server-side)
- **zod** — request validation on all endpoints

## Project Structure
```
backend/
  src/
    routes/             # Express routers: sessions, check-in, members, admin, governance, club, art
    services/
      qr.service.ts         # QR payload sign/verify
      relay.service.ts      # Nonce management, broadcast, replacement, confirmation
      relayWork.service.ts  # What gets sent: votes, mint batches, credit pages
      indexer.service.ts    # Registry, Rep, Governor and Timelock events → database
      onchain.service.ts    # All contract reads
      governance.service.ts # Proposals and relayed votes
      review.service.ts     # Anomaly flags for the second officer
      alerts.service.ts     # Officer alerts and open-session warnings
      rep.service.ts        # Timestamped current Rep
      sessions / meetings / identity / stats / ipfs / art .service.ts
    jobs/runner.ts      # The single-flight loops: indexer, relay, alerts, balance
    middleware/         # auth (Privy), admin (on-chain officer check), validate, rateLimit
    lib/
      abi.ts            # Generated: `npx tsx scripts/sync-abi.ts` (never edit)
      config.ts         # Environment variables
      contract.ts       # viem clients and the two accounts
      keyChecks.ts      # Startup refusal of over-powered keys
  scripts/              # sync-abi, legacy-export
  prisma/
```

## API Conventions

### Routing
- All routes prefixed `/api/v1/`
- RESTful resource naming (nouns, not verbs)
- Admin routes under `/api/v1/admin/` — always require `adminMiddleware`

### Request / Response
- All request bodies validated with Zod schemas before handler logic
- Successful responses: `{ data: T }`
- Error responses: `{ error: { code: string, message: string } }`
- HTTP status codes used correctly: 200, 201, 400, 401, 403, 404, 409, 500
- Never leak stack traces or internal errors to clients

### Auth
- Member auth: Privy JWT in `Authorization: Bearer <token>` header, verified server-side
- Officer auth: Privy JWT + live on-chain `ADMIN_ROLE` check; fails closed
- Every session, QR, export and PII route uses `adminMiddleware`, which reads the chain on
  each request (no role cache). `test/officer.access.test.ts` fails if a new session or
  admin route is not covered.
- `req.user` is typed as `{ privyUserId: string, walletAddress: string }`
- `walletAddress` is always the Privy **embedded** wallet (`services/identity.service.ts`);
  never `user.wallet`, which can be a linked external wallet

## QR Payload Spec
```ts
type QRPayload = {
  sessionId: string;   // on-chain session ID
  issuedAt: number;    // Unix timestamp ms
  expiresAt: number;   // Unix timestamp ms (issuedAt + QR_TTL_MS)
  nonce: string;       // random uuid, single-use
}
// Signed with QR_SIGNER_PRIVATE_KEY as EIP-712 `CheckInQR`
// Encoded as base64 JSON for QR code
```

## Check-in signatures
Both signatures are EIP-712 with domain `{name: 'OCP Check-In', version: '1', chainId,
verifyingContract: CONTRACT_ADDRESS}` (`src/lib/typedData.ts`, mirrored in
`frontend/lib/typedData.ts`). The member signs `CheckIn{sessionId, member, signedAt}`.

## Session identity
A session is identified by `(registryAddress, sessionIdOnchain)`. Look sessions up only with
`sessionKey()` / `findSessionOr404()` from `src/lib/session.ts`, never by on-chain id alone.

## Transaction Relay
- One sender (`relay.service.ts`); run **one backend instance**. A unique key on the nonce
  stops a second instance from double-spending it, but nothing coordinates two.
- Work is queued as rows with status `PENDING` (check-ins, votes) or derived from state
  (credit pages); `relayTick` sends it without waiting for earlier transactions.
- A row is written with the signed hash before broadcasting. Statuses:
  `PENDING → SUBMITTED → CONFIRMED` (after `CONFIRMATIONS` blocks) or `FAILED`.
- The oldest unmined transaction is replaced with higher fees after
  `RELAY_STUCK_AFTER_MS`, or cancelled if it would now revert. Fees never exceed
  `RELAY_MAX_FEE_GWEI`.
- Check-ins are coalesced into one `mintBatch` per session (≤ 200). Votes are one
  transaction each. Credit pages (≤ 100) follow the on-chain cursor.
- Simulate before sending; never pay for a call that would revert.

## Indexer
- One cursor per registry, `CONFIRMATIONS` deep, applied in order inside a database
  transaction. Every write is idempotent, and a status never moves backwards on replay.
- Rep decays without events: never sum `rep_events` into a balance. Read `getVotes` and
  show the block time (`asOf`).

## Conventions
- All DB queries through Prisma — no raw SQL unless performance-critical (document why)
- Wallet addresses stored lowercase, validated as checksummed on input
- All timestamps stored as UTC in DB
- Sensitive config (private keys, DB URL) via environment variables only — never committed
- BigInt from viem/contracts serialized as strings in JSON responses

## FORBIDDEN
- Raw `fetch` to RPC — use viem
- Sending a transaction from a route handler — queue a row and let the relay send it
- Granting or revoking roles from the backend, or giving it a `DEFAULT_ADMIN_ROLE` key (#82)
- Storing private keys anywhere except environment variables
- `any` type
- `console.log` — use a structured logger (e.g. `pino`)
- Trusting member-supplied wallet addresses for minting without signature verification

## Environment Variables
Every variable read by `src/`, `scripts/` or `prisma/seed.ts` must be listed here and in
`.env.example` (a test enforces the latter).
```
# Required at startup
DATABASE_URL
ALCHEMY_API_KEY            # or RPC_URL, which takes precedence
CONTRACT_ADDRESS           # AttendanceRegistry2
REP_ADDRESS
GOVERNOR_ADDRESS
TIMELOCK_ADDRESS
INDEXER_START_BLOCK        # Deployment block of the contracts
RELAY_PRIVATE_KEY          # RELAY_ROLE only
QR_SIGNER_PRIVATE_KEY      # Signs QR payloads; no on-chain role
PRIVY_APP_ID
PRIVY_APP_SECRET
CORS_ORIGINS               # Comma-separated frontend origins allowed by CORS

# Optional
LEGACY_REGISTRY_ADDRESS    # Needed once if session rows predate registry scoping
CHAIN_ID                   # 8453 (Base) or 84532 (Base Sepolia). Default: 84532
QR_TTL_MS                  # Default and maximum: 300000 (5 min)
PORT                       # Default: 3001
NODE_ENV                   # "production" switches to JSON logs at info level
PUBLIC_API_URL             # Base URL for art/badge links. Default: empty (relative URLs)
PINATA_JWT                 # Default: unset (no pinning)
CONTRACT_BASE_CID          # Default: unset (metadata URIs are null)
DEFAULT_SEMESTER_ART_CID   # Default: placeholder CID
SEMESTER_ART_CIDS          # JSON object {semester: cid}. Default: none
RELAY_MIN_BALANCE_ETH      # Default: 0.005
RELAY_MAX_FEE_GWEI         # Default: 5
RELAY_STUCK_AFTER_MS       # Default: 60000
RELAY_TICK_MS              # Default: 3000
CONFIRMATIONS              # Default: 5
INDEXER_POLL_MS            # Default: 5000
INDEXER_BLOCK_CHUNK        # Default: 2000
OPEN_SESSION_WARN_HOURS    # Default: 6
ALERT_WEBHOOK_URL          # Default: unset (alerts go to the log and dashboard)
```

## Tests
- `npm test`: unit and API tests (Postgres only; the chain is mocked).
- `npm run test:e2e`: real contracts on anvil through the API, relay and indexer. Needs
  Foundry and `smart-contract/lib`.
