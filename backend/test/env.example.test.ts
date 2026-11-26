import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(rel);
    return rel.endsWith('.ts') ? [rel] : [];
  });
}

describe('.env.example', () => {
  it('lists every environment variable the backend reads', () => {
    const files = [...sourceFiles('src'), ...sourceFiles('scripts'), 'prisma/seed.ts'];
    const read = new Set(
      files.flatMap((file) =>
        [...readFileSync(path.join(root, file), 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(
          (m) => m[1],
        ),
      ),
    );
    // Assigned (optionally commented out) at the start of a line.
    const example = readFileSync(path.join(root, '.env.example'), 'utf8');
    const listed = new Set([...example.matchAll(/^(?:# )?([A-Z0-9_]+)=/gm)].map((m) => m[1]));

    expect([...read].filter((name) => !listed.has(name))).toEqual([]);
  });
});
