"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal(props: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { onClose } = props;

  // Escape closes, but only when there is something to close to. A dialog that is mid-transaction
  // passes no onClose, and then Escape must do nothing — walking away from a signed transaction
  // hides it rather than stopping it.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (onClose && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <header>
          <h3>{props.title}</h3>
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Zavřít">
              <X />
            </button>
          )}
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}
