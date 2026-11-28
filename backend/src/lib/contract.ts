import { createPublicClient, createWalletClient, defineChain, http, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base, foundry } from 'viem/chains';
import { addresses } from './config';

function resolveChain(chainId: number): Chain {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  if (chainId === foundry.id) return foundry;
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
}

export const chain: Chain = resolveChain(parseInt(process.env.CHAIN_ID ?? '84532', 10));

const alchemyNetwork = chain.id === base.id ? 'base-mainnet' : 'base-sepolia';
// RPC_URL takes precedence, for local chains and other providers.
const rpcUrl =
  process.env.RPC_URL || `https://${alchemyNetwork}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;

/** The registry this deployment reads, writes and binds check-in signatures to. */
export const registryAddress = addresses.registry;

export const publicClient = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });

/** Pays gas for mints, Rep credit pages and relayed votes. Holds RELAY_ROLE only. */
export const relayAccount = privateKeyToAccount(process.env.RELAY_PRIVATE_KEY as `0x${string}`);

/** Signs QR payloads. Holds no on-chain role at all. */
export const qrAccount = privateKeyToAccount(process.env.QR_SIGNER_PRIVATE_KEY as `0x${string}`);

export const relayWalletClient = createWalletClient({
  account: relayAccount,
  chain,
  transport: http(rpcUrl),
});
