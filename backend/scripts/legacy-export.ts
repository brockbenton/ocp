/**
 * Read-only export of the legacy registry's history, the input to the Phase 5 bootstrap
 * scripts (smart-contract/DEPLOY.md).
 *
 *   npx tsx scripts/legacy-export.ts <rpc-url> <registry> <deploy-block> <out.json> [chunk]
 *
 * `chunk` is the number of blocks per log query (default 2000); lower it if the RPC refuses.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, getAddress, http, isAddress, parseAbiItem } from 'viem';

const SESSION_CREATED = parseAbiItem(
  'event SessionCreated(uint256 indexed sessionId, uint64 date, string name, string semester)',
);
const TOKEN_MINTED = parseAbiItem('event TokenMinted(address indexed to, uint256 indexed sessionId)');
const ROLE_GRANTED = parseAbiItem(
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
);

async function main(): Promise<void> {
  const [rpcUrl, registry, deployBlock, outFile, chunkArg] = process.argv.slice(2);
  if (!rpcUrl || !registry || !isAddress(registry) || !deployBlock || !outFile) {
    process.stderr.write(
      'Usage: legacy-export.ts <rpc-url> <registry> <deploy-block> <out.json> [chunk]\n',
    );
    process.exit(1);
  }

  const client = createPublicClient({ transport: http(rpcUrl) });
  const chunk = BigInt(chunkArg ?? '2000');
  const latest = await client.getBlockNumber();

  const sessionIds = new Set<bigint>();
  const accounts = new Set<string>();
  const roleHolders = new Set<string>();

  for (let from = BigInt(deployBlock); from <= latest; from += chunk) {
    const toBlock = from + chunk - 1n > latest ? latest : from + chunk - 1n;
    const logs = await client.getLogs({
      address: registry,
      events: [SESSION_CREATED, TOKEN_MINTED, ROLE_GRANTED],
      fromBlock: from,
      toBlock,
      strict: true,
    });
    for (const log of logs) {
      if (log.eventName === 'SessionCreated') sessionIds.add(log.args.sessionId);
      else if (log.eventName === 'TokenMinted') accounts.add(getAddress(log.args.to));
      else roleHolders.add(getAddress(log.args.account));
    }
  }

  // The constructor grants roles, so an empty list means the deploy block is wrong.
  if (roleHolders.size === 0) {
    throw new Error('No RoleGranted events found: check the registry address and deploy block');
  }

  const data = {
    registry: getAddress(registry),
    exportedAtBlock: latest.toString(),
    roleHolders: [...roleHolders].sort(),
    sessionIds: [...sessionIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String),
    accounts: [...accounts].sort(),
  };
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(data, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${outFile}: ${data.roleHolders.length} role holders, ` +
      `${data.sessionIds.length} sessions, ${data.accounts.length} accounts (block ${latest})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
