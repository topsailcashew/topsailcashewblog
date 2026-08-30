/**
 * Renders one Open Graph card per published post into `public/og/<slug>.png`.
 *
 * Why a build step rather than Next's `opengraph-image.tsx`: that route pulls
 * satori and the resvg WASM into the Worker bundle, which measured at 3289 KiB
 * gzipped — 217 KiB past Cloudflare's 3 MiB limit for a Worker script. Running
 * the same renderer in Node at build time produces identical images, ships
 * them as static assets (which do not count toward that limit), and costs
 * nothing at request time.
 *
 * Trade-off: a post published after a deploy has no card of its own until the
 * next build. `src/app/(public)/[slug]/page.tsx` falls back to the site-wide
 * image in that window.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { createNodeDb } from "../src/db/node";
import { listPublishedSlugs, getPublishedPost } from "../src/lib/public-posts";
import { requireDatabaseUrl } from "./load-env";

const WIDTH = 1200;
const HEIGHT = 630;
const OUT_DIR = path.join("public", "og");

const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME ?? "Topsail Cashew";

function card(title: string, dateLabel: string) {
  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: "#fdfcfa",
        padding: "72px 80px",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontSize: 26,
              letterSpacing: 3,
              color: "#767268",
              textTransform: "uppercase",
            },
            children: SITE_NAME,
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontSize: title.length > 60 ? 62 : 76,
              fontWeight: 700,
              lineHeight: 1.14,
              letterSpacing: -1.5,
              color: "#1b1a17",
            },
            children: title,
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", alignItems: "center", gap: 20 },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    width: 64,
                    height: 4,
                    backgroundColor: "#1c5d4a",
                  },
                },
              },
              {
                type: "div",
                props: {
                  style: { display: "flex", fontSize: 26, color: "#6d6a63" },
                  children: dateLabel,
                },
              },
            ],
          },
        },
      ],
    },
  } as unknown as React.ReactNode;
}

async function main() {
  const url = requireDatabaseUrl();
  const { db, pool } = createNodeDb(url);

  const [regular, bold] = await Promise.all([
    readFile(path.join("scripts", "assets", "noto-serif-400.ttf")),
    readFile(path.join("scripts", "assets", "noto-serif-700.ttf")),
  ]);
  const fonts = [
    { name: "Noto Serif", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Noto Serif", data: bold, weight: 700 as const, style: "normal" as const },
  ];

  await mkdir(OUT_DIR, { recursive: true });

  try {
    const slugs = await listPublishedSlugs(db);
    // The fallback used by posts published since the last build.
    const targets: { slug: string; title: string; date: string }[] = [
      { slug: "default", title: SITE_NAME, date: "" },
    ];

    for (const slug of slugs) {
      const post = await getPublishedPost(db, slug);
      if (!post) continue;
      const when = post.published_at ?? post.created_at;
      targets.push({
        slug,
        title: post.title,
        date: new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(when)),
      });
    }

    for (const target of targets) {
      const svg = await satori(card(target.title, target.date), {
        width: WIDTH,
        height: HEIGHT,
        fonts,
      });
      const png = new Resvg(svg, {
        fitTo: { mode: "width", value: WIDTH },
      })
        .render()
        .asPng();
      await writeFile(path.join(OUT_DIR, `${target.slug}.png`), png);
    }

    console.log(`Generated ${targets.length} Open Graph card(s) in ${OUT_DIR}/`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Open Graph generation failed:", error);
  process.exit(1);
});
