import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: [
          "/api/",
          "/admin/",
          "/dashboard",
          "/sessions/",
          "/credits/",
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
