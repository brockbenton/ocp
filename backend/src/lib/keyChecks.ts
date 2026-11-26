import { qrAccount, relayAccount } from './contract';
import logger from './logger';
import { rolesHeldBy } from '../services/onchain.service';

/**
 * Refuses to run with a key that is more powerful than it should be (#55): the QR key
 * must hold no role anywhere, and the relay must hold nothing beyond minting.
 */
export async function assertKeyRoles(): Promise<void> {
  const [qrRoles, relayRoles] = await Promise.all([
    rolesHeldBy(qrAccount.address),
    rolesHeldBy(relayAccount.address),
  ]);
  if (qrRoles.length > 0) {
    throw new Error(`QR signer ${qrAccount.address} must hold no on-chain role, has: ${qrRoles.join(', ')}`);
  }
  const excess = relayRoles.filter((role) => role !== 'registry.RELAY_ROLE');
  if (excess.length > 0) {
    throw new Error(`Relay ${relayAccount.address} must only mint, also has: ${excess.join(', ')}`);
  }
  if (!relayRoles.includes('registry.RELAY_ROLE')) {
    // Possible during a relay rotation; votes and credit pages still work without it.
    logger.warn({ msg: 'Relay wallet has no RELAY_ROLE: tokens cannot be minted', relay: relayAccount.address });
  }
}
