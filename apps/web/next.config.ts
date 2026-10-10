import type { NextConfig } from 'next';

/**
 * The wallet connector barrel pulls in every connector wagmi ships. Base Account reaches for x402
 * packages it declares as optional and nobody installed; MetaMask's SDK reaches for React Native
 * storage when it thinks it is on a phone. Nothing in this app loads those paths, so the
 * specifiers resolve to an empty module and the build stays quiet.
 * `pino-pretty` and friends are the same case on the WalletConnect side.
 */
const UNUSED_OPTIONAL_MODULES = [
  '@x402/core/client',
  '@x402/svm/exact/client',
  '@x402/evm',
  '@react-native-async-storage/async-storage',
];

/**
 * Sent on every route. The console asks people to sign for money, so no other site may frame it:
 * a page that overlays its own buttons on this one can steer a click onto "Approve".
 *
 * The one exception is the Safe app. A Safe connects to the console only by opening it inside
 * app.safe.global, where every action becomes a Safe transaction its owners confirm in Safe's own
 * interface, and the console sees nothing of their keys. Safe's origin is the whole allowance.
 *
 * The policy is `frame-ancestors` and nothing else on purpose. A full policy has to list every
 * origin the wallet connectors reach for, and getting one wrong breaks connecting with no error a
 * reader would recognise. X-Frame-Options cannot name an origin, and a browser that reads the
 * policy ignores it anyway, so it is left out rather than sent as a contradiction.
 */
const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'self' https://app.safe.global" },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  headers: async () => [
    { source: '/:path*', headers: SECURITY_HEADERS },
    // Safe reads the manifest from its own origin before it will open the console as a custom app.
    { source: '/manifest.json', headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }] },
  ],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  webpack: (webpackConfig, { isServer, webpack }) => {
    webpackConfig.externals.push('pino-pretty', 'lokijs', 'encoding');

    webpackConfig.resolve.alias = {
      ...webpackConfig.resolve.alias,
      ...Object.fromEntries(UNUSED_OPTIONAL_MODULES.map((name) => [name, false])),
    };

    // @bursar/core is written for Node and exports everything through a single entry, so a browser
    // build pulls in two builtins along with the parts it actually uses. Both are replaced with
    // shims in src/lib/node, not a general Node polyfill: `Buffer` is real, and the crypto path
    // behind it belongs to the facilitator and says so if it is ever called here.
    if (!isServer) {
      webpackConfig.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:buffer$/, (resource: { request: string }) => {
          resource.request = require.resolve('./src/lib/node/buffer.ts');
        }),
        new webpack.NormalModuleReplacementPlugin(/^node:crypto$/, (resource: { request: string }) => {
          resource.request = require.resolve('./src/lib/node/crypto.ts');
        }),
      );
    }

    return webpackConfig;
  },
};

export default config;
