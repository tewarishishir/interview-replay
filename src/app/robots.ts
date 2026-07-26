import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: [
          "/api/",
          "/dashboard",
          "/sessions/",
          "/stories/",
          "/rebuilds/",
          "/account",
          "/profile",
          "/signin",
          "/signup",
          "/forgot-password",
          "/reset-password",
          "/verify-email-required",
        ],
      },
    ],
    sitemap: "https://localhost:3000/sitemap.xml",
  };
}
