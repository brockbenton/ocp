# Backend — Rules & Conventions

## Phase 5 v1 target: participation reputation

The current attendance backend is not yet the DAO implementation. For Phase 5, follow `../MASTER_PLAN.md`.

## Stack
- **Node.js** + **Express** + **TypeScript** (strict)
- **PostgreSQL** + **Prisma ORM** — all DB access through Prisma client
- **Alchemy** — Base RPC endpoint, used through viem
- **viem** — contract interaction, signing, encoding (server-side)
- **BullMQ** + **Redis** — async job queue for transaction relay
- **zod** — request validation on all endpoints

## Project Structure
```
backend/
  src/
    routes/             # Express routers, one file per domain
      sessions.ts       # Session CRUD + QR generation
      check-in.ts       # Check-in verification + relay queue
      members.ts        # Member stats + token history
      admin.ts          # Admin dashboard endpoints
    services/
      qr.service.ts     # QR payload sign/verify logic
      relay.service.ts  # Transaction relay (mint via contract)
      stats.service.ts  # Attendance stat calculations
    jobs/
      mint.job.ts       # BullMQ job: send mint transaction
    middleware/
      auth.ts           # Privy JWT verification
      admin.ts          # Admin role check (on-chain)
      validate.ts       # Zod request validation wrapper
    lib/
      prisma.ts         # Prisma client singleton
      contract.ts       # viem clients and accounts
      abi.ts            # Minimal contract ABI
    types/              # Shared TypeScript types
  prisma/
    schema.prisma
    migrations/
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
- Admin auth: Privy JWT + on-chain `ADMIN_ROLE` check; fails closed
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
// Signed with ADMIN_SIGNER_PRIVATE_KEY as EIP-712 `CheckInQR`
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
- Relay wallet address holds `RELAY_ROLE` on the contract
- Mints are queued as BullMQ jobs — never blocking the HTTP response
- Job retries: max 3, exponential backoff
- Failed mints after retries: logged to DB with `status: 'failed'`, alertable
- Relay wallet balance monitored — alert if below threshold

## Conventions
- All DB queries through Prisma — no raw SQL unless performance-critical (document why)
- Wallet addresses stored lowercase, validated as checksummed on input
- All timestamps stored as UTC in DB
- Sensitive config (private keys, DB URL) via environment variables only — never committed
- BigInt from viem/contracts serialized as strings in JSON responses

## FORBIDDEN
- Raw `fetch` to RPC — use viem
- Directly calling contract from route handler — always go through relay queue
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
REDIS_URL
ALCHEMY_API_KEY
CONTRACT_ADDRESS
RELAY_PRIVATE_KEY          # Wallet with RELAY_ROLE
ADMIN_SIGNER_PRIVATE_KEY   # Wallet with ADMIN_ROLE; signs QR payloads
PRIVY_APP_ID
PRIVY_APP_SECRET
CORS_ORIGINS               # Comma-separated frontend origins allowed by CORS

# Optional
CHAIN_ID                   # 8453 (Base Mainnet) or 84532 (Base Sepolia). Default: 84532
QR_TTL_MS                  # Default and maximum: 300000 (5 min)
PORT                       # Default: 3001
NODE_ENV                   # "production" switches to JSON logs at info level
PUBLIC_API_URL             # Base URL for art/badge links. Default: empty (relative URLs)
PINATA_JWT                 # Default: unset (metadata publish is a dry run)
CONTRACT_BASE_CID          # Default: unset (metadata URIs are null)
DEFAULT_SEMESTER_ART_CID   # Default: placeholder CID
SEMESTER_ART_CIDS          # JSON object {semester: cid}. Default: none
OFFICIAL_MEMBER_THRESHOLD  # Default: 75
RELAY_MIN_BALANCE_ETH      # Default: 0.005
```

