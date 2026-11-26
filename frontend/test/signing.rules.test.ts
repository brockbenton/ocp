import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Privy delegated actions or session signers would let a server sign for members (#70).
const root = path.resolve(__dirname, '..');
const sources = ['app', 'components', 'hooks', 'lib'].flatMap((dir) =>
  (readdirSync(path.join(root, dir), { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => path.join(dir, file)),
);
const matching = (pattern: RegExp) =>
  sources.filter((file) => pattern.test(readFileSync(path.join(root, file), 'utf8')));

describe('signing rules', () => {
  it('never uses delegated actions or session signers', () => {
    expect(
      matching(/useDelegatedActions|useHeadlessDelegatedActions|delegateWallet|useSessionSigners|addSessionSigners|useSigners|addSigners/),
    ).toEqual([]);
  });

  it('never hides a Privy confirmation, and turns them on for the app', () => {
    expect(matching(/showWalletUIs:\s*false/)).toEqual([]);
    expect(readFileSync(path.join(root, 'components/providers/AppProviders.tsx'), 'utf8')).toContain(
      'showWalletUIs: true',
    );
  });
});
