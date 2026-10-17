/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Legal pages moved to flat URLs; keep any old links and bookmarks working.
  async redirects() {
    return [
      { source: "/legal/terms", destination: "/legal-terms", permanent: true },
      { source: "/legal/risk", destination: "/legal-risk", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
