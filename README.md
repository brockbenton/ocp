# Onchain Club Protocol (OCP)

Onchain Club Protocol (OCP) — an onchain protocol for running clubs, starting with a university blockchain club. Members check in at a meeting by scanning a time‑boxed, signed QR and receive a non‑transferable ERC‑1155 attendance token. Checking in is **gasless**: a backend relay sponsors the mint.

## Club DAO v1 (built, not deployed)

OCP's v1 DAO turns verified attendance into a say in how the club runs.

- **Earning:** each verified attendance earns **10 Rep**, once a first officer closes the meeting with its attendee list and a **second officer** approves it.
- **Gradual decay:** Rep is voting power and fades continuously, so continued participation maintains it. The **180‑day half‑life is provisional**.
- **Permanent attendance:** attendance tokens and lifetime history never decay.
- **Governance:** members vote for free; officers and settings change only through passed proposals and a Timelock. Rep can't be transferred, bought or delegated.

**Status:** the contracts, backend and app are implemented and tested on a local chain. They are **not deployed or audited**, and the half‑life, the 30 Rep proposal threshold and the 100 Rep quorum floor are provisional. Recovery after a long break and the officer‑collusion threat model are still to be decided: two colluding officers can approve fabricated meetings with no limit on Rep issued over time, and decay does not prevent that. See [MASTER_PLAN.md](MASTER_PLAN.md#phase-5--club-dao-v1-our-club), [SECURITY.md](SECURITY.md) and issues #50, #61, #68 and #77.

## Structure

- `smart-contract/` — Solidity + Foundry on Base: the deployed `AttendanceRegistry`, and the Phase 5 `AttendanceRegistry2`, `ClubRep`, `ClubGovernor` and `ClubTimelock`.
- `backend/` — Node/Express/TypeScript, PostgreSQL + Prisma, transaction relay, event indexer, QR signing.
- `frontend/` — Next.js 14, Privy (email/Google/passkey), viem, Tailwind.

## Quick start

- Contracts: `cd smart-contract && forge test` (dependencies: see `.github/workflows/ci.yml`)
- Backend: `cd backend && npm i && npm test` — needs Postgres. `npm run test:e2e` runs the whole system on a local chain. `npm run dev` needs deployed Phase 5 contracts (see `backend/.env.example`).
- Frontend: `cd frontend && npm i && npm test && npm run dev` (see `frontend/.env.example`)
- Deploying: [smart-contract/DEPLOY.md](smart-contract/DEPLOY.md)

CI (GitHub Actions) runs the contract tests, backend and frontend tests and builds, and the end‑to‑end suite on every PR.
