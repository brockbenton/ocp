# Frontend — Rules & Conventions

## Phase 5 (club DAO)

Follow `../MASTER_PLAN.md`. Officers run meetings and members vote from their own wallets.

## Stack
- **Next.js 14** (App Router, `app/` directory)
- **TypeScript** — strict mode, no `any`
- **Tailwind CSS** — UI primitives live in `components/ui/`
- **Privy** (`@privy-io/react-auth`) — wallet connection, social login, embedded wallets
- **viem** — chain definitions and typed addresses
- **TanStack Query** (`@tanstack/react-query`) — all async data fetching and caching

## Project Structure
```
frontend/
  app/                    # Next.js App Router pages
    admin/                # Officer pages (role-gated): meetings, review, members, officers
    governance/           # Proposals and voting
    check-in/             # QR scan + check-in flow
    vault/                # Member's token gallery
    stats/                # Personal attendance stats
  components/
    ui/                   # Shared UI primitives
    shared/               # Reusable app-level components
    features/             # Feature-specific components (check-in/, vault/, admin/)
  lib/
    api/                  # Typed fetch wrappers for backend API
  hooks/                  # Custom React hooks
  types/                  # Shared TypeScript types/interfaces
  test/                   # Vitest + Testing Library (`npm test`)
```

## Conventions

### Components
- One component per file. Filename = PascalCase component name.
- Co-locate styles with the component (Tailwind only — no CSS modules, no inline styles).
- Server Components by default. Add `"use client"` only when needed (event handlers, hooks, browser APIs).
- Props interfaces named `{ComponentName}Props`, defined directly above the component.

### Data Fetching
- All API calls go through typed wrappers in `lib/api/` — never raw `fetch` in components.
- Use TanStack Query for all async data. No `useEffect` + `useState` for data fetching.
- Query keys are defined as constants in `lib/api/queryKeys.ts`.

### Contract Interaction
- Read the chain through `publicClient` (`lib/chain.ts`): it is independent of the backend,
  which matters for checks like `hasVoted`.
- Send transactions only with `useWalletTx` (simulates first, shows Privy's confirmation,
  waits for the receipt). Attendance minting still goes through the backend relay.
- ABIs are generated into `lib/abi.ts` by `backend/scripts/sync-abi.ts`. Never edit it.
- Contract addresses come from `lib/constants.ts` (env vars, never hardcoded).
- Describe proposals from their calldata (`lib/proposals.ts`) and verify the proposal id
  before asking anyone to sign.

### Signing
- Keep Privy's confirmation on (`showWalletUIs: true`) and say in plain words what is being
  signed. **Never enable delegated actions or session signers** (a test enforces this).

### Auth / Wallet
- Use `usePrivy()` and `useWallets()` from Privy everywhere. Never access `window.ethereum` directly.
- Gate admin pages with role check from backend — do not trust on-chain role reads alone for UI gating.
- Wallet address is always lowercase (`address.toLowerCase()`).

### Error Handling
- All API errors are typed (never `catch (e: any)`).
- User-facing errors display inline — no raw `alert()`.
- Loading states are always handled — no unhandled suspense boundaries.

## FORBIDDEN
- `any` type — use `unknown` and narrow, or define proper types
- `console.log` in committed code — use a logger utility
- Hardcoded contract addresses or API URLs — use env vars (`NEXT_PUBLIC_*`)
- Direct DOM manipulation outside of refs
- `useEffect` for data fetching — use TanStack Query

## Environment Variables
```
NEXT_PUBLIC_PRIVY_APP_ID
NEXT_PUBLIC_CONTRACT_ADDRESS     # AttendanceRegistry2
NEXT_PUBLIC_REP_ADDRESS
NEXT_PUBLIC_GOVERNOR_ADDRESS
NEXT_PUBLIC_TIMELOCK_ADDRESS
NEXT_PUBLIC_API_URL
NEXT_PUBLIC_RPC_URL              # Optional; defaults to the chain's public RPC
```
