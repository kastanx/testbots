/** @type {import('next').NextConfig} */
const nextConfig = {
    // The repo root has its own lockfile (the Electron panel's), and Turbopack
    // walks up until it finds one. Pin it here or every build warns about it.
    turbopack: { root: import.meta.dirname },

    // Screenshots come from Vercel Blob, which serves them straight from its own
    // CDN. Next's image optimiser would add a hop and a transform for no gain.
    images: { unoptimized: true }
};

export default nextConfig;
