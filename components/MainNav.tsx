"use client";

import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string };

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/ask", label: "Ask AI" },
  { href: "/explore/contracts", label: "Contracts" },
  { href: "/explore/grants", label: "Grants" },
  { href: "/network", label: "Network" },
  { href: "/entity/search", label: "Entity Lookup" },
  { href: "/challenges", label: "Challenges" },
];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export default function MainNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation">
      <ul
        style={{
          display: "flex",
          gap: "1.5rem",
          listStyle: "none",
          margin: 0,
          padding: 0,
          flexWrap: "wrap",
        }}
      >
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={active ? "page" : undefined}
                style={{
                  color: "white",
                  textDecoration: active ? "underline" : "none",
                  textUnderlineOffset: "4px",
                  textDecorationThickness: "2px",
                  fontWeight: active ? 700 : 400,
                }}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
