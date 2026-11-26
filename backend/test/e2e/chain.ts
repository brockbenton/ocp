/** A throwaway anvil chain with the club bootstrapped by the real Foundry scripts. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  type Abi,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const ROOT = path.resolve(__dirname, '../../..');
const CONTRACTS = path.join(ROOT, 'smart-contract');
const BACKEND = path.join(ROOT, 'backend');
// Prefer the default Foundry install (some systems have an unrelated `forge` on PATH);
// otherwise, as on CI, take whatever PATH provides.
const DEFAULT_BIN = path.join(homedir(), '.foundry/bin');
const FOUNDRY_BIN =
  process.env.FOUNDRY_BIN ?? (existsSync(path.join(DEFAULT_BIN, 'forge')) ? DEFAULT_BIN : '');
const PORT = 8547;
export const RPC = `http://127.0.0.1:${PORT}`;

// Anvil's public development mnemonic. These keys are worthless outside a local chain.
const MNEMONIC = 'test test test test test test test test test test test junk';
const account = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });
const privateKey = (index: number) =>
  `0x${Buffer.from(account(index).getHdKey().privateKey!).toString('hex')}` as `0x${string}`;

export const actors = {
  deployer: account(0),
  relay: account(1),
  officerA: account(2),
  officerB: account(3),
  alice: account(4),
  bob: account(5),
  guardian: account(6),
  qr: account(7),
  carol: account(8),
  officerC: account(9),
};
export const keys = { deployer: privateKey(0), relay: privateKey(1), qr: privateKey(7) };

export const client = createPublicClient({ chain: foundry, transport: http(RPC), cacheTime: 0 });
export const admin = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC) });

/** Sends a transaction from an actor's own wallet, as an officer or member would. */
export async function transact(
  who: ReturnType<typeof account>,
  address: `0x${string}`,
  abi: Abi,
  functionName: string,
  args: unknown[] = [],
) {
  const wallet = createWalletClient({ account: who, chain: foundry, transport: http(RPC) });
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  return receipt;
}

/** Moves chain time forward and mines a block. */
export async function warp(seconds: number): Promise<void> {
  await admin.increaseTime({ seconds });
  await admin.mine({ blocks: 1 });
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  return execFileSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
}

function forgeScript(name: string, env: Record<string, string>): string {
  return run(
    path.join(FOUNDRY_BIN, 'forge'),
    ['script', `script/${name}`, '--rpc-url', RPC, '--private-key', keys.deployer, '--broadcast', '--slow'],
    CONTRACTS,
    env,
  );
}

export interface Deployment {
  legacy: `0x${string}`;
  registry: `0x${string}`;
  rep: `0x${string}`;
  governor: `0x${string}`;
  timelock: `0x${string}`;
  startBlock: bigint;
}

const LEGACY_ABI = parseAbi([
  'function createSession(uint256 id, uint64 date, string name, string semester)',
  'function mint(address to, uint256 sessionId)',
]);

export async function startChain(): Promise<{ stop: () => void }> {
  const anvil: ChildProcess = spawn(path.join(FOUNDRY_BIN, 'anvil'), ['--port', String(PORT)], {
    stdio: 'ignore',
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.getBlockNumber();
      break;
    } catch (err) {
      if (attempt > 100) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    stop: () => {
      anvil.kill();
      rmSync(path.join(CONTRACTS, 'data/e2e'), { recursive: true, force: true });
      rmSync(path.join(CONTRACTS, 'broadcast'), { recursive: true, force: true });
    },
  };
}

/** Legacy history (alice attended two meetings, bob one), then the whole bootstrap. */
export async function bootstrapClub(): Promise<Deployment> {
  const deployed = forgeScript('Deploy.s.sol', { RELAY_WALLET: actors.relay.address, BASE_CID: 'legacy' });
  const legacy = /deployed at: (0x[0-9a-fA-F]{40})/.exec(deployed)![1] as `0x${string}`;
  for (const id of [1000n, 2000n]) {
    await transact(actors.deployer, legacy, LEGACY_ABI, 'createSession', [id, 1_700_000_000n, 'Legacy', 'Spring 2026']);
  }
  for (const [member, id] of [[actors.alice, 1000n], [actors.alice, 2000n], [actors.bob, 1000n]] as const) {
    await transact(actors.relay, legacy, LEGACY_ABI, 'mint', [member.address, id]);
  }

  mkdirSync(path.join(CONTRACTS, 'data/e2e'), { recursive: true });
  const exportFile = path.join(CONTRACTS, 'data/e2e/legacy.json');
  run('npx', ['tsx', 'scripts/legacy-export.ts', RPC, legacy, '0', exportFile], BACKEND);
  const exported = JSON.parse(readFileSync(exportFile, 'utf8')) as { accounts: string[] };
  if (exported.accounts.length !== 2) throw new Error('Unexpected legacy export');

  const env = { LEGACY_REGISTRY: legacy, LEGACY_DATA: 'data/e2e/legacy.json' };
  forgeScript('FreezeLegacy.s.sol', env);
  const startBlock = await client.getBlockNumber();
  const output = forgeScript('DeployClub.s.sol', {
    ...env,
    RELAY_WALLET: actors.relay.address,
    GUARDIAN_SAFE: actors.guardian.address,
    OFFICERS: `${actors.officerA.address},${actors.officerB.address}`,
    BASE_CID: 'base',
    ALLOW_EOA_GUARDIAN: 'true',
  });
  const address = (label: string) =>
    new RegExp(`${label}:\\s+(0x[0-9a-fA-F]{40})`).exec(output)![1] as `0x${string}`;
  const club = {
    legacy,
    startBlock,
    timelock: address('ClubTimelock'),
    rep: address('ClubRep'),
    registry: address('AttendanceRegistry2'),
    governor: address('ClubGovernor'),
  };
  forgeScript('ImportLegacy.s.sol', {
    ...env,
    CLUB_TIMELOCK: club.timelock,
    CLUB_REP: club.rep,
    CLUB_REGISTRY: club.registry,
    CLUB_GOVERNOR: club.governor,
    FINALIZE: 'true',
  });
  return club;
}
