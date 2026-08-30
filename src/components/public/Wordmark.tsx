import { siteConfig } from "@/lib/site";

/**
 * The masthead (Design.md §8).
 *
 * This is the *only* place the display face appears. Titles elsewhere — cards,
 * posts, page heads, prose headings — are the serif, so a post's title looks
 * the same in the grid as it does on its own page.
 *
 * Condensation is the typeface's own (Anton), not letter-spacing — §4 is
 * explicit that faking it is not acceptable.
 */
/**
 * The hero sets the name as one unbroken wordmark — "TOPSAILCASHEW", the way
 * Design.md writes it — so it can be sized to fill the column on a single
 * line. The nav keeps the spaced form, which reads better at chrome scale.
 */
function heroWordmark(): string {
  return siteConfig.name.replace(/\s+/g, "");
}

export function Wordmark({
  as: Tag = "h1",
  className,
}: {
  as?: "h1" | "p" | "span";
  className?: string;
}) {
  return (
    <Tag className={["wordmark--hero", className].filter(Boolean).join(" ")}>
      {heroWordmark()}
    </Tag>
  );
}
