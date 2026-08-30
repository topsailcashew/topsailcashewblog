import Link from "next/link";
import { formatDate } from "@/lib/site";

type Props = {
  publishedAt: string;
  readingMinutes: number;
  tags?: { name: string; slug: string }[];
};

/** Date · reading time · tags. Sans-serif, so it reads as chrome, not prose. */
export function PostMeta({ publishedAt, readingMinutes, tags = [] }: Props) {
  return (
    <div className="meta">
      <time dateTime={publishedAt}>{formatDate(publishedAt)}</time>
      <span className="meta-dot" aria-hidden="true">
        ·
      </span>
      <span>{readingMinutes} min read</span>
      {tags.length > 0 && (
        <>
          <span className="meta-dot" aria-hidden="true">
            ·
          </span>
          <span className="tag-list">
            {tags.map((tag) => (
              <Link key={tag.slug} href={`/tag/${tag.slug}`} className="tag">
                {tag.name}
              </Link>
            ))}
          </span>
        </>
      )}
    </div>
  );
}
