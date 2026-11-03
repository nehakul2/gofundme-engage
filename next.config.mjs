/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pg and ioredis use Node APIs; keep them out of the bundler
  serverExternalPackages: ['pg', 'ioredis'],
};

export default nextConfig;
