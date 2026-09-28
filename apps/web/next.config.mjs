/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ["@zipnet/sdk"],
  webpack(config, { isServer }) {
    // snarkjs/ffjavascript reference Node builtins they never use in the browser
    if (!isServer) config.resolve.fallback = { ...config.resolve.fallback, fs: false, os: false, readline: false, constants: false, path: false, crypto: false };
    return config;
  },
};
