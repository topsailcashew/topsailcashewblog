import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { BLOCK_FORMAT_VERSION, toBlocks } from "@/lib/blocks";
import { handle, json, notFound } from "@/lib/http";
import { getPublishedPost } from "@/lib/public-posts";
import { absoluteUrl, siteConfig } from "@/lib/site";

/**
 * GET /api/content/:slug — one published post as decoupled content blocks.
 *
 * Public, and deliberately so: this is the syndication surface. It carries
 * exactly what the RSS feed already carries — published posts, nothing else —
 * in a form another platform can render natively instead of embedding a web
 * view around someone's HTML.
 *
 * `getPublishedPost` is the same function the reading page uses, so a draft, a
 * scheduled post and a trashed one are all 404 here for the same reason they
 * are 404 there. There is no second definition of "published" to keep in step.
 */
export const revalidate = 300;

export const GET = handle(
  async (_request: NextRequest, context: { params: Promise<{ slug: string }> }) => {
    const { slug } = await context.params;
    const post = await getPublishedPost(getDb(), slug);
    if (!post) throw notFound("Post");

    return json({
      format: { name: "topsail-blocks", version: BLOCK_FORMAT_VERSION },
      post: {
        id: post.id,
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        url: absoluteUrl(`/${post.slug}`),
        canonical_url: post.canonical_url ?? absoluteUrl(`/${post.slug}`),
        cover_image_url: post.cover_image_url,
        published_at: post.published_at,
        updated_at: post.updated_at,
        author: siteConfig.author,
        language: siteConfig.language,
        tags: post.tags.map((tag) => tag.name),
      },
      blocks: toBlocks(post.content_json),
    });
  },
);
