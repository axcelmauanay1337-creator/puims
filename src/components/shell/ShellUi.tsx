"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

interface ShellUi {
  drawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
}

const Ctx = createContext<ShellUi | null>(null);

export function ShellUiProvider({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = usePathname();
  const [lastPath, setLastPath] = useState(pathname);

  // Close transient UI on navigation (render-phase state adjustment).
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setDrawerOpen(false);
    setPaletteOpen(false);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo(() => ({ drawerOpen, setDrawerOpen, paletteOpen, setPaletteOpen }), [drawerOpen, paletteOpen]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShellUi(): ShellUi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShellUi must be used inside ShellUiProvider");
  return v;
}
