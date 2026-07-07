import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Parking How Much?",
    short_name: "Parking How Much?",
    description:
      "Find the cheapest commercial carpark near you in Singapore for your exact parking duration.",
    start_url: "/",
    display: "standalone",
    background_color: "#f0fdfa",
    theme_color: "#0d9488",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
