/**
 * Writes the contract ABIs the apps use from Foundry's build output, so they cannot
 * drift from the Solidity. Run after `forge build`:
 *
 *   cd backend && npx tsx scripts/sync-abi.ts          # rewrite the generated files
 *   cd backend && npx tsx scripts/sync-abi.ts --check  # fail if they are out of date
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const CONTRACTS = {
  REGISTRY_ABI: 'AttendanceRegistry2',
  REP_ABI: 'ClubRep',
  GOVERNOR_ABI: 'ClubGovernor',
  TIMELOCK_ABI: 'ClubTimelock',
} as const;
const OUTPUTS = ['backend/src/lib/abi.ts', 'frontend/lib/abi.ts'];
const HEADER = `// Generated from smart-contract/out by backend/scripts/sync-abi.ts. Do not edit.\n`;

function abiOf(contract: string): unknown[] {
  const file = path.join(ROOT, 'smart-contract/out', `${contract}.sol`, `${contract}.json`);
  const artifact = JSON.parse(readFileSync(file, 'utf8')) as { abi: { type: string }[] };
  return artifact.abi.filter((entry) => entry.type !== 'constructor');
}

// One entry per line keeps the generated diff readable.
const body = Object.entries(CONTRACTS)
  .map(([name, contract]) => {
    const entries = abiOf(contract).map((entry) => `  ${JSON.stringify(entry)},`);
    return `export const ${name} = [\n${entries.join('\n')}\n] as const;\n`;
  })
  .join('\n');
const generated = `${HEADER}\n${body}`;

const check = process.argv.includes('--check');
const stale = OUTPUTS.filter((output) => {
  const file = path.join(ROOT, output);
  if (!check) {
    writeFileSync(file, generated);
    return false;
  }
  return readFileSync(file, 'utf8') !== generated;
});

if (stale.length > 0) {
  process.stderr.write(`ABI out of date: ${stale.join(', ')}. Run scripts/sync-abi.ts.\n`);
  process.exit(1);
}
process.stdout.write(check ? 'ABI files are up to date\n' : `Wrote ${OUTPUTS.join(', ')}\n`);
