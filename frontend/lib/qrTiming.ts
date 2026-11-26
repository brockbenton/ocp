/** The replacement QR is fetched this long before the shown one expires. */
export const REFRESH_LEAD_MS = 90_000;

export interface QrTiming {
  /** Local-clock time the shown QR stops being accepted. */
  expiresAt: number;
  /** Local-clock time to fetch the replacement. */
  refreshAt: number;
}

/**
 * Anchors the QR's lifetime to the moment it arrived, so a projector whose clock
 * differs from the server's still refreshes on time. Returns null if unreadable.
 */
export function qrTiming(encoded: string, receivedAt: number): QrTiming | null {
  try {
    const { payload } = JSON.parse(atob(encoded)) as {
      payload: { issuedAt: unknown; expiresAt: unknown };
    };
    const { issuedAt, expiresAt } = payload;
    if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number') return null;
    const lifetime = expiresAt - issuedAt;
    if (lifetime <= 0) return null;
    // Short-lived codes refresh halfway through instead of immediately.
    const lead = Math.min(REFRESH_LEAD_MS, lifetime / 2);
    return { expiresAt: receivedAt + lifetime, refreshAt: receivedAt + lifetime - lead };
  } catch {
    return null;
  }
}
