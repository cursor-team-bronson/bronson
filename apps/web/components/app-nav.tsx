"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const links = [
  { href: "/dag", label: "DAG editor" },
  { href: "/run", label: "Model runner" },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-6 px-5 sm:px-8">
        <Link href="/dag" className="text-sm font-semibold tracking-tight text-foreground">
          Bronson
        </Link>
        <nav className="flex items-center gap-1" aria-label="Primary">
          {links.map(({ href, label }) => {
            const active = pathname === href || (href === "/dag" && pathname === "/");
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
