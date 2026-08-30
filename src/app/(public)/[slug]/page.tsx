import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getDb } from "@/db/client";
import { PostMeta } from "@/components/public/PostMeta";
import {
  getPublishedPost,
  listPublishedSlugs,
  readingMinutes,
} from "@/lib/public-posts";
import { absoluteUrl, siteConfig } from "@/lib/site";

export const revalidate = 3600;

type Params = Promise<{ slug: string }>;

/**
 * Pre-renders every published post at build time when the database is
 * reachable. Anything not listed here — a post published after the build —
 * renders on first request and is cached from then on.
 */
export async function generateStaticParams() {
  try {
    const slugs = await listPublishedSlugs(getDb());
    return slugs.map((slug) => ({ slug }));
  } catch {
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedPost(getDb(), slug);
  if (!post) return { title: "Not found" };

  const description = post.excerpt ?? siteConfig.description;
  return {
    title: post.title,
    description,
    alternates: { canonical: `/${post.slug}` },
    openGraph: {
      type: "article",
      title: post.title,
      description,
      url: absoluteUrl(`/${post.slug}`),
      publishedTime: post.published_at ?? undefined,
      images: post.cover_image_url ? [post.cover_image_url] : undefined,
    },
  };
}

export default async function PostPage({ params }: { params: Params }) {
  const { slug } = await params;

  // getPublishedPost filters on status, so a draft is indistinguishable from a
  // slug that does not exist — both are a real 404, not a soft error page.
  const post = await getPublishedPost(getDb(), slug);
  if (!post) notFound();

  return (
    <article className="wrap">
      <header className="post-header">
        <h1 className="post-title">{post.title}</h1>
        {post.excerpt && <p className="post-standfirst">{post.excerpt}</p>}
        <PostMeta
          publishedAt={post.published_at ?? post.created_at}
          readingMinutes={readingMinutes(post.content_html)}
          tags={post.tags}
        />
        {post.cover_image_url && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="post-cover"
            src={post.cover_image_url}
            alt=""
            fetchPriority="high"
          />
        )}
      </header>

      {/*
        content_html is produced by Tiptap's own serializer from this blog's
        single trusted author, and the schema admits no raw HTML nodes — so
        this is rendering our own output, not reader input.
      */}
      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: post.content_html ?? "" }}
      />

      <footer className="post-footer">
        <Link href="/">← All posts</Link>
        {post.tags.length > 0 && (
          <span className="tag-list">
            {post.tags.map((tag) => (
              <Link key={tag.slug} href={`/tag/${tag.slug}`} className="tag">
                {tag.name}
              </Link>
            ))}
          </span>
        )}
      </footer>
    </article>
  );
}
