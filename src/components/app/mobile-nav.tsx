"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  BookOpen,
  LayoutDashboard,
  Menu,
  UserRound,
  X,
  LogOut,
} from "lucide-react";

import { signOutAction } from "@/lib/auth/actions";
import { cn } from "@/lib/utils";

interface MobileNavProps {
  userName: string | null;
  userEmail: string;
}

const navLinks = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/stories", label: "Story bank", icon: BookOpen },
  { href: "/profile", label: "Profile", icon: UserRound },
] as const;

export function MobileNav({ userName, userEmail }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className="sm:hidden flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      >
        <Menu className="size-5" aria-hidden />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] bg-black/50 sm:hidden"
          aria-hidden
          onClick={() => setOpen(false)}
        />
      )}

      <div
        className={cn(
          "fixed inset-y-0 left-0 z-[70] flex w-72 flex-col bg-background shadow-xl transition-transform duration-300 ease-in-out sm:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <div className="flex h-16 items-center justify-between border-b border-border px-4">
          <span className="text-sm font-medium text-foreground">
            {userName ?? userEmail}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <nav aria-label="Mobile primary" className="flex-1 overflow-y-auto px-3 py-4">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-3 text-sm font-medium transition-colors",
                pathname === link.href || pathname?.startsWith(link.href + "/")
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <link.icon className="size-4 shrink-0" aria-hidden />
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="border-t border-border p-4">
          <p className="mb-3 truncate text-xs text-muted-foreground">{userEmail}</p>
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                await signOutAction();
              })
            }
            className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          >
            <LogOut className="size-4 shrink-0" aria-hidden />
            {isPending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </>
  );
}
