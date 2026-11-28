import { describe, it, expect, vi, beforeEach } from 'vitest';

const roles = vi.hoisted(() => ({ qr: [] as string[], relay: [] as string[] }));

vi.mock('../src/services/onchain.service', async () => {
  const { qrAccount } = await import('../src/lib/contract');
  return {
    rolesHeldBy: async (wallet: string) => (wallet === qrAccount.address ? roles.qr : roles.relay),
  };
});

import { assertKeyRoles } from '../src/lib/keyChecks';

beforeEach(() => {
  roles.qr = [];
  roles.relay = ['registry.RELAY_ROLE'];
});

describe('startup key checks', () => {
  it('accepts a role-less QR key and a mint-only relay', async () => {
    await expect(assertKeyRoles()).resolves.toBeUndefined();
  });

  it.each(['registry.ADMIN_ROLE', 'registry.RELAY_ROLE', 'timelock.CANCELLER_ROLE'])(
    'refuses a QR key holding %s',
    async (role) => {
      roles.qr = [role];
      await expect(assertKeyRoles()).rejects.toThrow('must hold no on-chain role');
    },
  );

  it.each(['registry.ADMIN_ROLE', 'registry.DEFAULT_ADMIN_ROLE', 'rep.MINTER_ROLE'])(
    'refuses a relay that also holds %s',
    async (role) => {
      roles.relay = ['registry.RELAY_ROLE', role];
      await expect(assertKeyRoles()).rejects.toThrow('must only mint');
    },
  );

  it('still starts during a relay rotation', async () => {
    roles.relay = [];
    await expect(assertKeyRoles()).resolves.toBeUndefined();
  });
});
