import { publicClient, adminWalletClient, relayWalletClient, adminAccount, relayAccount, chain } from '../lib/contract';
import { ATTENDANCE_ABI } from '../lib/abi';
import logger from '../lib/logger';

const contractAddress = process.env.CONTRACT_ADDRESS as `0x${string}`;

/** Logs a submitted tx and waits for its receipt. */
async function confirmTx(
  action: string,
  hash: `0x${string}`,
  context: Record<string, unknown>,
): Promise<`0x${string}`> {
  logger.info({ msg: `${action} tx submitted`, hash, ...context });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  // A mined transaction can still have reverted; callers must not record it as done.
  if (receipt.status !== 'success') {
    throw new Error(`${action} reverted on-chain (tx ${hash})`);
  }
  logger.info({ msg: `${action} confirmed`, hash, ...context });
  return hash;
}

export async function createSessionOnChain(
  sessionIdOnchain: string,
  date: Date,
  name: string,
  semester: string,
): Promise<`0x${string}`> {
  const hash = await adminWalletClient.writeContract({
    address: contractAddress,
    abi: ATTENDANCE_ABI,
    functionName: 'createSession',
    args: [BigInt(sessionIdOnchain), BigInt(Math.floor(date.getTime() / 1000)), name, semester],
    account: adminAccount,
    chain,
  });

  return confirmTx('createSession', hash, { sessionIdOnchain });
}

export async function closeSessionOnChain(sessionIdOnchain: string): Promise<`0x${string}`> {
  const hash = await adminWalletClient.writeContract({
    address: contractAddress,
    abi: ATTENDANCE_ABI,
    functionName: 'closeSession',
    args: [BigInt(sessionIdOnchain)],
    account: adminAccount,
    chain,
  });

  return confirmTx('closeSession', hash, { sessionIdOnchain });
}

export async function mintOnChain(
  to: `0x${string}`,
  sessionIdOnchain: string,
): Promise<`0x${string}`> {
  const hash = await relayWalletClient.writeContract({
    address: contractAddress,
    abi: ATTENDANCE_ABI,
    functionName: 'mint',
    args: [to, BigInt(sessionIdOnchain)],
    account: relayAccount,
    chain,
  });

  return confirmTx('mint', hash, { to, sessionIdOnchain });
}

export const relayAddress = relayAccount.address;

/** Native (gas) balance of the relay wallet, in wei. */
export async function getRelayBalanceWei(): Promise<bigint> {
  return publicClient.getBalance({ address: relayAccount.address });
}
