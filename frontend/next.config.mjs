// Wallet features need Privy everywhere, so a build without it must fail loudly.
if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) {
  throw new Error('NEXT_PUBLIC_PRIVY_APP_ID is required. Set it in frontend/.env.local.');
}

// Check-in signatures are bound to the registry, so a wrong or missing address would
// make every check-in fail. Same value as the backend's CONTRACT_ADDRESS.
if (!/^0x[0-9a-fA-F]{40}$/.test(process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? '')) {
  throw new Error('NEXT_PUBLIC_CONTRACT_ADDRESS must be the registry address. Set it in frontend/.env.local.');
}

// No script/connect CSP on purpose: Privy loads its own iframe and endpoints, and
// frame-ancestors only restricts who may frame this app, not what it frames.
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  // The camera stays available to this origin for the check-in QR scanner.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
