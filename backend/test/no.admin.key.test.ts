import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const src = path.resolve(__dirname, '../src');
const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
const matching = (pattern: RegExp) =>
  files.filter((file) => pattern.test(readFileSync(path.join(src, file), 'utf8')));

// The backend holds no officer or admin power (#55, #82): its keys mint and sign QR codes.
describe('backend privileges', () => {
  it('references no admin key', () => {
    expect(matching(/DEFAULT_ADMIN_PRIVATE_KEY|ADMIN_SIGNER_PRIVATE_KEY|defaultAdmin|adminAccount/)).toEqual([]);
  });

  it('never calls a function that changes roles, sessions or sign-off, except paged credit', () => {
    expect(
      matching(
        /functionName: '(grantRole|revokeRole|createSession|closeSession|confirmSessionRep|rejectSessionRep|pauseMinting|unpauseMinting|setBaseCid|grant|revoke)'/,
      ),
    ).toEqual([]);
  });

  it('sends transactions from one place only', () => {
    expect(matching(/sendRawTransaction|writeContract|sendTransaction/)).toEqual(['services/relay.service.ts']);
  });
});
