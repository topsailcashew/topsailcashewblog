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
