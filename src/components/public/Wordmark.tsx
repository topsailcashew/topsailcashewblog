import { siteConfig } from "@/lib/site";

/**
 * The display-type wordmark (Design.md §8), reusable at hero and post scale.
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
  as: Tag = "span",
  scale = "hero",
  children,
  className,
}: {
  as?: "h1" | "h2" | "span" | "p";
  scale?: "hero" | "post" | "card";
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Tag
      className={[`wordmark`, `wordmark--${scale}`, className]
        .filter(Boolean)
        .join(" ")}
    >
      {children ?? (scale === "hero" ? heroWordmark() : siteConfig.name)}
    </Tag>
  );
}
