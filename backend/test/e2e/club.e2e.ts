/**
 * The club from bootstrap to executed proposal, through the real API, relay and indexer
 * against real contracts. Steps build on each other and run in order.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { formatGwei, formatUnits, keccak256, stringToBytes, toBytes, encodeFunctionData } from 'viem';
// What the browser signs when voting.
import * as browser from '../../../frontend/lib/typedData';
import { actors, admin, bootstrapClub, client, keys, startChain, transact, warp, RPC, type Deployment } from './chain';

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    // The bearer token is the wallet to sign in as.
    async getUser({ idToken }: { idToken: string }) {
      return {
        id: `did:privy:${idToken.toLowerCase()}`,
        linkedAccounts: [{ type: 'wallet', walletClientType: 'privy', address: idToken }],
      };
    }
    async getUsers() {
      return [];
    }
  },
}));

const CONFIRMATIONS = 2;
const REP = 10n ** 18n;
const databaseUrl = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/ocp_test',
);
// Suffix the database name itself, not any query string: this database is reset.
databaseUrl.pathname += '_e2e';
const database = databaseUrl.toString();

type Actor = (typeof actors)['alice'];
const lower = (actor: Actor) => actor.address.toLowerCase();

let chainProcess: { stop: () => void };
let club: Deployment;
let webhook: Server;
const alerts: string[] = [];
let api: ReturnType<typeof request>;
let m: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  return {
    app: await import('../../src/app'),
    indexer: await import('../../src/services/indexer.service'),
    relayWork: await import('../../src/services/relayWork.service'),
    alerts: await import('../../src/services/alerts.service'),
    keyChecks: await import('../../src/lib/keyChecks'),
    typed: await import('../../src/lib/typedData'),
    governance: await import('../../src/services/governance.service'),
    abi: await import('../../src/lib/abi'),
    prisma: (await import('../../src/lib/prisma')).default,
  };
}

beforeAll(async () => {
  chainProcess = await startChain();
  club = await bootstrapClub();

  webhook = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      alerts.push((JSON.parse(body) as { text: string }).text);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve));
  const { port } = webhook.address() as { port: number };

  Object.assign(process.env, {
    DATABASE_URL: database,
    RPC_URL: RPC,
    CHAIN_ID: '31337',
    CONTRACT_ADDRESS: club.registry,
    REP_ADDRESS: club.rep,
    GOVERNOR_ADDRESS: club.governor,
    TIMELOCK_ADDRESS: club.timelock,
    LEGACY_REGISTRY_ADDRESS: club.legacy,
    INDEXER_START_BLOCK: club.startBlock.toString(),
    CONFIRMATIONS: String(CONFIRMATIONS),
    RELAY_PRIVATE_KEY: keys.relay,
    QR_SIGNER_PRIVATE_KEY: keys.qr,
    PRIVY_APP_ID: 'e2e',
    PRIVY_APP_SECRET: 'e2e',
    CORS_ORIGINS: 'http://localhost:3000',
    ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}`,
    NODE_ENV: 'production',
  });
  // The real migrations, on an empty database.
  execFileSync('npx', ['prisma', 'migrate', 'reset', '--force', '--skip-generate', '--skip-seed'], {
    env: process.env,
    stdio: 'ignore',
  });
  m = await loadModules();
  api = request(m.app.createApp());
});

afterAll(async () => {
  await m?.prisma.$disconnect();
  webhook?.close();
  chainProcess?.stop();
});

// ── helpers ──────────────────────────────────────────────────────────────

const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.address}` });

/** Mines enough blocks for the latest transactions to count as final. */
const finalize = () => admin.mine({ blocks: CONFIRMATIONS });

async function index() {
  await finalize();
  await m.indexer.indexToHead();
}

/** Send queued work, let it confirm, and settle it. */
async function relayRound() {
  await m.relayWork.relayTick();
  await finalize();
  await m.relayWork.relayTick();
}

const registry = (who: Actor, fn: string, args: unknown[] = []) =>
  transact(who, club.registry, m.abi.REGISTRY_ABI, fn, args);

let nextSession = 1n;
async function openSession(name: string, max = 30): Promise<string> {
  const id = nextSession++;
  const { timestamp } = await client.getBlock();
  await registry(actors.officerA, 'createSession', [id, timestamp, name, 'Fall 2026', max, '']);
  const res = await api.post(`/api/v1/sessions/${id}/sync`).set(as(actors.officerA));
  expect(res.status).toBe(200);
  return String(id);
}

async function checkIn(member: Actor, sessionId: string) {
  const qr = await api.get(`/api/v1/sessions/${sessionId}/qr`).set(as(actors.officerA));
  expect(qr.status).toBe(200);
  const signedAt = Date.now();
  const memberSignature = await member.signTypedData({
    domain: m.typed.checkInDomain(31337, club.registry),
    types: m.typed.CHECK_IN_TYPES,
    primaryType: 'CheckIn',
    message: { sessionId: BigInt(sessionId), member: member.address, signedAt: BigInt(signedAt) },
  });
  return api
    .post('/api/v1/check-in')
    .set(as(member))
    .send({ qrPayload: qr.body.data.qr, memberSignature, signedAt });
}

async function closeWithList(sessionId: string) {
  const list = await api.get(`/api/v1/admin/sessions/${sessionId}/close-list`).set(as(actors.officerA));
  expect(list.status).toBe(200);
  await registry(actors.officerA, 'closeSession', [BigInt(sessionId), list.body.data.attendees]);
  await index();
  return list.body.data as { attendees: string[]; waiting: number };
}

const repOf = async (member: Actor) =>
  (await api.get(`/api/v1/members/${member.address}/rep`)).body.data as {
    rep: string;
    asOf: string;
    waiting: { sessionId: string; status: string }[];
  };

const session = (sessionIdOnchain: string) =>
  m.prisma.session.findFirstOrThrow({
    where: { sessionIdOnchain, registryAddress: club.registry.toLowerCase() },
    include: { checkIns: true },
  });

async function signBallot(member: Actor, proposalId: string, support: number) {
  const nonce = await client.readContract({
    address: club.governor,
    abi: m.abi.GOVERNOR_ABI,
    functionName: 'nonces',
    args: [member.address],
  });
  return member.signTypedData({
    domain: m.governance.governorDomain(),
    types: m.governance.BALLOT_TYPES,
    primaryType: 'Ballot',
    message: { proposalId: BigInt(proposalId), support, voter: member.address, nonce },
  });
}

async function propose(description: string, calls: { target: `0x${string}`; data: `0x${string}` }[]) {
  // Proposal power is read a second in the past. Bulk mining leaves anvil's chain clock
  // ahead of the one it estimates gas with, so move both well past the latest credit.
  await warp(120);
  const args = [calls.map((c) => c.target), calls.map(() => 0n), calls.map((c) => c.data), description];
  await transact(actors.alice, club.governor, m.abi.GOVERNOR_ABI, 'propose', args);
  await index();
  const row = await m.prisma.proposal.findFirstOrThrow({ where: { description } });
  const execution = [args[0], args[1], args[2], keccak256(stringToBytes(description))];
  return { id: row.proposalId, operationId: row.operationId as `0x${string}`, execution };
}

const proposalFromApi = async (id: string) =>
  (await api.get(`/api/v1/governance/proposals/${id}`)).body.data;

// ── the story ────────────────────────────────────────────────────────────

describe('club DAO end to end', () => {
  it('accepts correctly limited keys and refuses a QR key that holds a role', async () => {
    await expect(m.keyChecks.assertKeyRoles()).resolves.toBeUndefined();
    await expect(
      (async () => {
        const { rolesHeldBy } = await import('../../src/services/onchain.service');
        expect(await rolesHeldBy(actors.officerA.address)).toEqual(['registry.ADMIN_ROLE']);
        expect(await rolesHeldBy(actors.qr.address)).toEqual([]);
        expect(await rolesHeldBy(club.timelock)).toContain('rep.DEFAULT_ADMIN_ROLE');
      })(),
    ).resolves.toBeUndefined();
    // The legacy registry grants nothing to the QR key either.
    const legacyRoles = await Promise.all(
      [keccak256(toBytes('ADMIN_ROLE')), keccak256(toBytes('RELAY_ROLE')), `0x${'0'.repeat(64)}` as const].map(
        (role) =>
          client.readContract({
            address: club.legacy,
            abi: m.abi.REGISTRY_ABI,
            functionName: 'hasRole',
            args: [role, actors.qr.address],
          }),
      ),
    );
    expect(legacyRoles).toEqual([false, false, false]);
  });

  it('indexes the legacy import and reports decayed Rep with an as-of time', async () => {
    await index();
    expect(await m.prisma.repEvent.count({ where: { type: 'IMPORT' } })).toBe(2);
    const alice = await repOf(actors.alice);
    expect(BigInt(alice.rep)).toBeGreaterThan(19n * REP);
    expect(BigInt(alice.rep)).toBeLessThanOrEqual(20n * REP);
    expect(Date.parse(alice.asOf)).toBeGreaterThan(0);
  });

  it('runs a meeting: batched mints, close list, second-officer review, paged credit', async () => {
    const id = await openSession('Kickoff');
    for (const member of [actors.alice, actors.bob, actors.carol]) {
      expect((await checkIn(member, id)).status).toBe(202);
    }

    await m.relayWork.relayTick();
    const sent = await session(id);
    expect(sent.checkIns.map((c) => c.mintStatus)).toEqual(['SUBMITTED', 'SUBMITTED', 'SUBMITTED']);
    // One mintBatch covers all three.
    expect(new Set(sent.checkIns.map((c) => c.relayTxId)).size).toBe(1);
    // Mined but not yet deep enough: still not final.
    await m.relayWork.relayTick();
    expect((await session(id)).checkIns.every((c) => c.mintStatus === 'SUBMITTED')).toBe(true);
    await finalize();
    await m.relayWork.relayTick();
    expect((await session(id)).checkIns.every((c) => c.mintStatus === 'CONFIRMED')).toBe(true);

    const list = await closeWithList(id);
    expect(list.waiting).toBe(0);
    expect(list.attendees.map((a) => a.toLowerCase()).sort()).toEqual(
      [actors.alice, actors.bob, actors.carol].map(lower).sort(),
    );

    const queueFor = async (officer: Actor) =>
      (await api.get('/api/v1/admin/review').set(as(officer))).body.data;
    const [forCloser] = await queueFor(actors.officerA);
    const [forSecond] = await queueFor(actors.officerB);
    expect(forCloser.canConfirm).toBe(false);
    expect(forSecond.canConfirm).toBe(true);
    expect(forSecond.flags.map((f: { code: string }) => f.code)).toContain('RECENT_WALLETS');
    await m.alerts.alertAnomalies();
    await m.alerts.alertAnomalies();
    expect(alerts.filter((a) => a.includes('Kickoff'))).toHaveLength(1);

    const pending = await repOf(actors.carol);
    expect(pending.rep).toBe('0');
    expect(pending.waiting).toEqual([{ sessionId: id, name: 'Kickoff', status: 'PENDING_APPROVAL' }]);

    await expect(registry(actors.officerA, 'confirmSessionRep', [BigInt(id)])).rejects.toThrow();
    await registry(actors.officerB, 'confirmSessionRep', [BigInt(id)]);
    await index();
    expect((await repOf(actors.carol)).waiting[0].status).toBe('AWAITING_CREDIT');

    await relayRound();
    await index();
    expect((await session(id)).repStatus).toBe('CREDITED');
    const carol = await repOf(actors.carol);
    expect(carol.waiting).toEqual([]);
    expect(Number(formatUnits(BigInt(carol.rep), 18))).toBeCloseTo(10, 2);

    const publicList = (await api.get('/api/v1/club/sessions')).body.data[0];
    expect(publicList).toMatchObject({ closedBy: lower(actors.officerA), confirmedBy: lower(actors.officerB) });
    expect(publicList.attendees).toHaveLength(3);
  });

  it('ranks the leaderboard by current Rep and keeps lifetime attendance separate', async () => {
    const { members, repAsOf, totalRep } = (await api.get('/api/v1/members')).body.data;
    expect(members.map((x: { walletAddress: string }) => x.walletAddress)).toEqual(
      [actors.alice, actors.bob, actors.carol].map(lower),
    );
    expect(members[0].tokensEarned).toBe(1);
    expect(Date.parse(repAsOf)).toBeGreaterThan(0);
    expect(BigInt(totalRep)).toBeGreaterThan(55n * REP);
  });

  it('relays a gasless vote, accepts a self-submitted one, and executes an officer election', async () => {
    // A second meeting lifts alice above the 30 Rep proposal threshold.
    const id = await openSession('Second');
    for (const member of [actors.alice, actors.bob]) expect((await checkIn(member, id)).status).toBe(202);
    await relayRound();
    await closeWithList(id);
    await registry(actors.officerB, 'confirmSessionRep', [BigInt(id)]);
    await index();
    await relayRound();

    const adminRole = keccak256(toBytes('ADMIN_ROLE'));
    const election = await propose('Appoint officer C', [
      {
        target: club.registry,
        data: encodeFunctionData({
          abi: m.abi.REGISTRY_ABI,
          functionName: 'grantRole',
          args: [adminRole, actors.officerC.address],
        }),
      },
    ]);
    expect(await proposalFromApi(election.id)).toMatchObject({ state: 'Pending', quorum: null });

    const early = await api
      .post('/api/v1/governance/votes')
      .set(as(actors.alice))
      .send({ proposalId: election.id, support: 1, signature: await signBallot(actors.alice, election.id, 1) });
    expect(early.body.error.code).toBe('VOTING_CLOSED');

    await warp(86_400 + 10);
    const signature = await signBallot(actors.alice, election.id, 1);
    const post = (member: Actor, support: number, sig: string) =>
      api
        .post('/api/v1/governance/votes')
        .set(as(member))
        .send({ proposalId: election.id, support, signature: sig });

    // The signature covers the choice and the voter.
    expect((await post(actors.alice, 0, signature)).body.error.code).toBe('INVALID_SIGNATURE');
    expect((await post(actors.bob, 1, signature)).body.error.code).toBe('INVALID_SIGNATURE');
    expect(
      (await post(actors.officerB, 1, await signBallot(actors.officerB, election.id, 1))).body.error.code,
    ).toBe('NO_VOTING_POWER');

    const accepted = await post(actors.alice, 1, signature);
    expect(accepted.status).toBe(202);
    expect(accepted.body.data.signature).toBe(signature);
    expect((await post(actors.alice, 1, signature)).body.error.code).toBe('VOTE_PENDING');
    // A bad vote queued first must not hold back or revert anyone else's.
    await m.prisma.vote.create({
      data: {
        proposalId: election.id,
        voter: lower(actors.bob),
        support: 1,
        signature: await signBallot(actors.bob, election.id, 0),
        createdAt: new Date(0),
      },
    });
    await relayRound();
    const bad = await m.prisma.vote.findFirstOrThrow({ where: { voter: lower(actors.bob) } });
    // Rejected by simulation on both relay passes, so never paid for.
    expect(bad).toMatchObject({ status: 'PENDING', attempts: 2, txHash: null });
    const mine = await api
      .get(`/api/v1/governance/proposals/${election.id}/my-vote`)
      .set(as(actors.alice));
    expect(mine.body.data.status).toBe('CONFIRMED');
    expect((await post(actors.alice, 1, signature)).body.error.code).toBe('ALREADY_VOTED');

    // Censorship fallback: an officer submits bob's signed vote without the backend. Bob
    // signs exactly the request the browser builds, so this also checks the app's ballot.
    const request = browser.ballotTypedData(31337, club.governor, {
      proposalId: election.id,
      support: 1,
      voter: actors.bob.address,
      nonce: '0',
    });
    const browserSignature = await actors.bob.signTypedData(
      JSON.parse(JSON.stringify(request)) as Parameters<typeof actors.bob.signTypedData>[0],
    );
    await transact(actors.officerA, club.governor, m.abi.GOVERNOR_ABI, 'castVoteBySig', [
      BigInt(election.id),
      1,
      actors.bob.address,
      browserSignature,
    ]);
    await index();
    const votes = (await api.get(`/api/v1/governance/proposals/${election.id}/votes`)).body.data;
    expect(votes.map((v: { status: string }) => v.status)).toEqual(['CONFIRMED', 'CONFIRMED']);

    await warp(7 * 86_400 + 10);
    expect((await proposalFromApi(election.id)).state).toBe('Succeeded');
    await transact(actors.alice, club.governor, m.abi.GOVERNOR_ABI, 'queue', election.execution);
    await warp(2 * 86_400 + 10);
    await transact(actors.carol, club.governor, m.abi.GOVERNOR_ABI, 'execute', election.execution);
    await index();
    const done = await proposalFromApi(election.id);
    expect(done.state).toBe('Executed');
    expect(done.executedAt).not.toBeNull();

    // The club overview caches briefly.
    await new Promise((resolve) => setTimeout(resolve, 10_100));
    const overview = (await api.get('/api/v1/club')).body.data;
    expect(overview.officers.map((o: { walletAddress: string }) => o.walletAddress)).toContain(
      lower(actors.officerC),
    );
    expect(overview.guardian).toMatchObject({ address: lower(actors.guardian), active: true });
    expect(overview.repHalfLifeSeconds).toBe(180 * 86_400);
    // The new officer can use the dashboard straight away.
    expect((await api.get('/api/v1/admin/me').set(as(actors.officerC))).status).toBe(200);
  });

  it('records a guardian veto from the Timelock', async () => {
    // A description that looks like hex is still hashed as text, here and by the Governor.
    const proposal = await propose('0xbeef', [
      {
        target: club.rep,
        data: encodeFunctionData({
          abi: m.abi.REP_ABI,
          functionName: 'grant',
          args: [actors.carol.address, 5n * REP, 'ipfs://reason'],
        }),
      },
    ]);
    await warp(86_400 + 10);
    for (const member of [actors.alice, actors.bob]) {
      await transact(member, club.governor, m.abi.GOVERNOR_ABI, 'castVote', [BigInt(proposal.id), 1]);
    }
    await warp(7 * 86_400 + 10);
    await transact(actors.alice, club.governor, m.abi.GOVERNOR_ABI, 'queue', proposal.execution);
    await transact(actors.guardian, club.timelock, m.abi.TIMELOCK_ABI, 'cancel', [proposal.operationId]);
    await index();
    const vetoed = await proposalFromApi(proposal.id);
    expect(vetoed.state).toBe('Canceled');
    expect(vetoed.canceledAt).not.toBeNull();
  });

  it('keeps a proposal cancelled before voting readable', async () => {
    const proposal = await propose('Withdrawn', [
      {
        target: club.rep,
        data: encodeFunctionData({
          abi: m.abi.REP_ABI,
          functionName: 'grant',
          args: [actors.carol.address, 1n * REP, 'ipfs://reason'],
        }),
      },
    ]);
    await transact(actors.alice, club.governor, m.abi.GOVERNOR_ABI, 'cancel', proposal.execution);
    await index();
    expect(await proposalFromApi(proposal.id)).toMatchObject({ state: 'Canceled', quorum: null });
    expect((await api.get('/api/v1/governance/proposals')).status).toBe(200);
    const mine = await api
      .get(`/api/v1/governance/proposals/${proposal.id}/my-vote`)
      .set(as(actors.alice));
    expect(mine.status).toBe(200);
  });

  it('warns once about a session left open, without closing it', async () => {
    const id = await openSession('Forgotten');
    await m.alerts.warnOpenSessions(Date.now() + 365 * 86_400_000);
    await m.alerts.warnOpenSessions(Date.now() + 365 * 86_400_000);
    expect(alerts.filter((a) => a.includes('Forgotten'))).toHaveLength(1);
    expect((await session(id)).closedAt).toBeNull();
  });

  it('replaces a stuck transaction with a higher fee at the same nonce', async () => {
    const id = await openSession('Stuck');
    expect((await checkIn(actors.alice, id)).status).toBe(202);
    process.env.RELAY_STUCK_AFTER_MS = '200';
    await admin.setAutomine(false);
    try {
      await m.relayWork.relayTick();
      const first = await m.prisma.relayTx.findFirstOrThrow({ where: { activeKey: { not: null } } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // A node that fails the re-simulation must not get the mint cancelled.
      const { publicClient } = await import('../../src/lib/contract');
      const outage = vi.spyOn(publicClient, 'call').mockRejectedValueOnce(new Error('429'));
      await m.relayWork.relayTick();
      expect(outage).toHaveBeenCalled();
      outage.mockRestore();
      const replaced = await m.prisma.relayTx.findUniqueOrThrow({ where: { id: first.id } });
      expect(replaced.hashes).toHaveLength(2);
      expect(replaced.cancelled).toBe(false);
      expect(BigInt(replaced.maxFeePerGas)).toBeGreaterThan(BigInt(first.maxFeePerGas));
      expect(BigInt(replaced.maxPriorityFeePerGas)).toBeGreaterThan(BigInt(first.maxPriorityFeePerGas));
      await admin.mine({ blocks: 1 });
    } finally {
      await admin.setAutomine(true);
      process.env.RELAY_STUCK_AFTER_MS = '60000';
    }
    await relayRound();
    const done = await session(id);
    expect(done.checkIns[0].mintStatus).toBe('CONFIRMED');
    expect(await m.prisma.relayTx.count({ where: { activeKey: { not: null } } })).toBe(0);
  });

  it('cancels a stuck transaction that would now revert, then fails the check-in honestly', async () => {
    const id = await openSession('Closed early');
    expect((await checkIn(actors.bob, id)).status).toBe(202);
    process.env.RELAY_STUCK_AFTER_MS = '200';
    await admin.setAutomine(false);
    try {
      await m.relayWork.relayTick();
      const row = await m.prisma.relayTx.findFirstOrThrow({ where: { activeKey: { not: null } } });
      // The network loses the mint; the officer closes the meeting meanwhile.
      await admin.dropTransaction({ hash: row.hashes[0] as `0x${string}` });
      await admin.setAutomine(true);
      await registry(actors.officerA, 'closeSession', [BigInt(id), []]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await m.relayWork.relayTick();
      const cancelled = await m.prisma.relayTx.findUniqueOrThrow({ where: { id: row.id } });
      expect(cancelled.cancelled).toBe(true);
      await relayRound();
      expect((await m.prisma.relayTx.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('CANCELLED');
    } finally {
      await admin.setAutomine(true);
      process.env.RELAY_STUCK_AFTER_MS = '60000';
    }
    await relayRound();
    const done = await session(id);
    expect(done.checkIns[0]).toMatchObject({
      mintStatus: 'FAILED',
      failureReason: 'The session closed before the token was minted',
    });
  });

  /** Queues a check-in, has the network lose its mint, then lets the row go stale. */
  async function loseMint(name: string, run: (tx: { id: string; nonce: number }) => Promise<void>) {
    const id = await openSession(name);
    expect((await checkIn(actors.alice, id)).status).toBe(202);
    process.env.RELAY_STUCK_AFTER_MS = '200';
    await admin.setAutomine(false);
    try {
      await m.relayWork.relayTick();
      const row = await m.prisma.relayTx.findFirstOrThrow({ where: { activeKey: { not: null } } });
      await admin.dropTransaction({ hash: row.hashes[0] as `0x${string}` });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await run(row);
    } finally {
      await admin.setAutomine(true);
      delete process.env.RELAY_MAX_FEE_GWEI;
      process.env.RELAY_STUCK_AFTER_MS = '60000';
    }
    await relayRound();
    expect((await session(id)).checkIns[0].mintStatus).toBe('CONFIRMED');
    expect(await m.prisma.relayTx.count({ where: { activeKey: { not: null } } })).toBe(0);
  }

  it('resends a transaction that is stuck at the fee ceiling', async () => {
    await loseMint('At the ceiling', async ({ id }) => {
      const first = await m.prisma.relayTx.findUniqueOrThrow({ where: { id } });
      // No room left under the ceiling for a replacement.
      process.env.RELAY_MAX_FEE_GWEI = formatGwei(BigInt(first.maxFeePerGas));
      await m.relayWork.relayTick();
      const resent = await m.prisma.relayTx.findUniqueOrThrow({ where: { id } });
      expect(resent.hashes).toEqual(first.hashes);
      await expect(client.getTransaction({ hash: first.hashes[0] as `0x${string}` })).resolves.toBeTruthy();
      await admin.mine({ blocks: 1 });
    });
  });

  it('releases work left in flight by a previous relay wallet', async () => {
    let oldRow = '';
    await loseMint('Rotated key', async ({ id, nonce }) => {
      oldRow = id;
      const previous = actors.bob.address;
      await m.prisma.relayTx.update({
        where: { id },
        data: { sender: previous, activeKey: `${previous}:${nonce}` },
      });
      await admin.setAutomine(true);
      await m.relayWork.relayTick();
    });
    expect((await m.prisma.relayTx.findUniqueOrThrow({ where: { id: oldRow } })).status).toBe('DROPPED');
  });

  it('turns check-ins away while minting is paused', async () => {
    const id = await openSession('Paused');
    await registry(actors.officerA, 'pauseMinting');
    const res = await checkIn(actors.alice, id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MINTING_PAUSED');
    await registry(actors.officerA, 'unpauseMinting');
    await registry(actors.officerB, 'unpauseMinting');
    expect((await checkIn(actors.alice, id)).status).toBe(202);
    await relayRound();
  });

  it('recognises a real revert from the node, and survives an outage without failing work', async () => {
    const { simulate, isRevert } = await import('../../src/services/relay.service');
    const data = encodeFunctionData({
      abi: m.abi.REGISTRY_ABI,
      functionName: 'mintBatch',
      args: [[actors.alice.address], 999_999n],
    });
    const revert = await simulate(club.registry, data).catch((err: unknown) => err);
    expect(isRevert(revert)).toBe(true);

    const id = await openSession('Outage');
    expect((await checkIn(actors.carol, id)).status).toBe(202);
    const reachable = await admin.snapshot();
    // Take the relay role away: mints would all revert, so they wait instead.
    const relayRole = keccak256(toBytes('RELAY_ROLE'));
    await admin.impersonateAccount({ address: club.timelock });
    await admin.setBalance({ address: club.timelock, value: REP });
    const { createWalletClient, http } = await import('viem');
    const { foundry } = await import('viem/chains');
    const asTimelock = createWalletClient({ account: club.timelock, chain: foundry, transport: http(RPC) });
    const revocation = await asTimelock.writeContract({
      address: club.registry,
      abi: m.abi.REGISTRY_ABI,
      functionName: 'revokeRole',
      args: [relayRole, actors.relay.address],
    });
    await client.waitForTransactionReceipt({ hash: revocation, pollingInterval: 100 });
    for (let tick = 0; tick < 8; tick += 1) await m.relayWork.relayTick();
    expect((await session(id)).checkIns[0]).toMatchObject({ mintStatus: 'PENDING', attempts: 0 });

    await admin.revert({ id: reachable });
    await relayRound();
    expect((await session(id)).checkIns[0].mintStatus).toBe('CONFIRMED');
  });

  it('can replay the whole index without changing anything', async () => {
    await index();
    const snapshot = async () => ({
      sessions: await m.prisma.session.findMany({ orderBy: { sessionIdOnchain: 'asc' } }),
      rep: await m.prisma.repEvent.count(),
      tokens: await m.prisma.tokenEvent.count(),
      proposals: await m.prisma.proposal.findMany({ orderBy: { proposalId: 'asc' } }),
      votes: await m.prisma.vote.count(),
    });
    const before = await snapshot();
    await m.prisma.indexerCursor.deleteMany();
    await m.indexer.indexToHead();
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});
