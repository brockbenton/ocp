import { APP_SHORT_NAME } from '../lib/brand';

/**
 * Deterministic, self-contained SVG art for attendance tokens and the founding badge,
 * generated (not fetched) so app imagery always resolves without external assets
 * or a pinned CID. The on-chain metadata image is handled by the IPFS pipeline.
 */
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '');

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
};

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]);
}

// Stable hue in [0,360) so a semester (or tier) always renders the same color.
function hashHue(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) % 360;
  return h;
}

export function renderSemesterBadgeSvg(semester: string): string {
  const hue = hashHue(semester);
  const c1 = `hsl(${hue} 75% 55%)`;
  const c2 = `hsl(${(hue + 40) % 360} 70% 42%)`;
  const label = escapeXml(semester);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="${APP_SHORT_NAME} attendance token — ${label}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
  <rect width="512" height="512" rx="48" fill="url(#g)"/>
  <circle cx="256" cy="212" r="118" fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.65)" stroke-width="6"/>
  <text x="256" y="248" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="104" font-weight="700" fill="#fff">AT</text>
  <text x="256" y="404" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#fff">${APP_SHORT_NAME}</text>
  <text x="256" y="448" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="rgba(255,255,255,0.92)">${label}</text>
</svg>`;
}

export function semesterArtPath(semester: string): string {
  return `/api/v1/art/${encodeURIComponent(semester)}`;
}

export function semesterArtUrl(semester: string): string {
  return `${PUBLIC_API_URL}${semesterArtPath(semester)}`;
}

const FOUNDING_LABEL = 'Founding Member';

export const FOUNDING_BADGE_PATH = '/api/v1/badge/founding';

export function foundingBadgeUrl(): string {
  return `${PUBLIC_API_URL}${FOUNDING_BADGE_PATH}`;
}

export function renderFoundingBadgeSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="${FOUNDING_LABEL} — ${APP_SHORT_NAME}">
  <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(38 92% 58%)"/><stop offset="1" stop-color="hsl(30 90% 45%)"/></linearGradient></defs>
  <rect width="512" height="512" rx="48" fill="#0f172a"/>
  <path d="M256 56 l150 54 v120 c0 118 -74 190 -150 226 c-76 -36 -150 -108 -150 -226 v-120 z" fill="url(#b)" stroke="rgba(255,255,255,0.7)" stroke-width="6"/>
  <text x="256" y="250" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="120" font-weight="800" fill="#fff">★</text>
  <text x="256" y="330" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#fff">${FOUNDING_LABEL}</text>
  <text x="256" y="372" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="24" fill="rgba(255,255,255,0.9)">${APP_SHORT_NAME}</text>
</svg>`;
}
