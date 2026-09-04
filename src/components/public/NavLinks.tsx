"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The nav links, with the current section marked in the accent.
 *
 * A client component only because it needs the current path. It is the one
 * place the accent does wayfinding rather than decoration — you can tell where
 * you are without reading.
 */
export function NavLinks({
  links,
}: {
  links: readonly { href: string; label: string }[];
}) {
  const pathname = usePathname();

  return (
    <>
      {links.map((link) => {
        /*
          A link off the site is a plain anchor, not a `Link`. Next's router
          has nothing to do with another origin, and the active check below
          could never match one — `pathname` is a path, never a full URL.

          It opens in a new tab so a reader partway through an essay does not
          lose it, which is the reason `rel="noopener"` is required: without
          it the opened page gets a handle on this one via `window.opener`.
        */
        if (/^https?:\/\//.test(link.href)) {
          return (
            <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          );
        }

        // A section, not an exact page: /articles stays lit on /articles?page=2
        // and an article's own URL is not any nav item, so nothing is lit.
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={active ? "is-current" : undefined}
            aria-current={active ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </>
  );
}
