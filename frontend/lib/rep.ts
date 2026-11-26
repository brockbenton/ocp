import { formatUnits } from 'viem';

/** An 18-decimal Rep string for display, rounded down to two decimals. */
export function formatRep(rep: string | bigint | null | undefined): string {
  if (rep === null || rep === undefined) return '-';
  const hundredths = BigInt(rep) / 10n ** 16n;
  return Number(formatUnits(hundredths, 2)).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Rep decays continuously, so every figure is shown with when it was read. */
export function formatAsOf(iso: string | null | undefined): string {
  if (!iso) return '';
  return `as of ${new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}
