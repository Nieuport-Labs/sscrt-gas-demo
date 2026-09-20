"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, LogOut, Settings } from "lucide-react";
import { shortenAddress } from "@/lib/format";

/**
 * The account switcher from the dashboard, minus the switching. Keplr decides which account is
 * active, so offering to add one here would be a button that cannot do what it says — the menu
 * shows which account is connected and the two things this app can actually do with it.
 */
export function WalletMenu(props: { address: string; onSettings: () => void; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="wallet" ref={root}>
      <button className="wallet-trigger" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <span className="avatar">sS</span>
        <span className="who">
          <span className="label">Main SCRT</span>
          <br />
          <span className="addr">{shortenAddress(props.address, 8, 4)}</span>
        </span>
        <span className="caret">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>

      {open && (
        <div className="wallet-menu" role="menu">
          <div className="wallet-item current">
            <span className="avatar" style={{ width: 26, height: 26 }}>
              sS
            </span>
            <span className="stack">
              Main SCRT
              <br />
              <span className="addr">{shortenAddress(props.address, 10, 6)}</span>
            </span>
            <span className="check">
              <Check size={15} />
            </span>
          </div>

          <div className="sep" />

          <button className="wallet-item" role="menuitem" onClick={() => choose(props.onSettings)}>
            <Settings />
            Nastavení
          </button>
          <button className="wallet-item" role="menuitem" onClick={() => choose(props.onDisconnect)}>
            <LogOut />
            Odpojit
          </button>
        </div>
      )}
    </div>
  );
}
