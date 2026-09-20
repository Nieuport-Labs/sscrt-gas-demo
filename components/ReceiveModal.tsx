"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Modal } from "./Modal";

export function ReceiveModal(props: { address: string; onClose: () => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(props.address, { type: "svg", margin: 0, errorCorrectionLevel: "M" })
      .then((markup) => {
        if (!cancelled) setSvg(markup);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [props.address]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (insecure origin, denied permission). The address is on
      // screen and selectable either way, so this is not worth an error dialog.
      setCopied(false);
    }
  };

  return (
    <Modal
      title="Přijmout sSCRT"
      onClose={props.onClose}
      footer={
        <>
          <span className="msg">{copied ? "Zkopírováno." : ""}</span>
          <button className="btn ghost" onClick={props.onClose}>
            Zavřít
          </button>
          <button className="btn primary" onClick={copy}>
            Kopírovat adresu
          </button>
        </>
      }
    >
      {/* The QR carries the bare address. Deliberately not an amount-bearing URI: wallets disagree
          on what those mean for SNIP-20 tokens, and a scanner that guessed wrong would prefill a
          native SCRT transfer instead. */}
      {svg ? (
        <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="qr" style={{ width: 200, height: 200 }} />
      )}

      <div className="addr-box">{props.address}</div>

      <p className="note">
        Tahle adresa přijímá sSCRT i nativní SCRT — je to jedna a tatáž adresa na Secret Network.
        Aplikace ukazuje jen sSCRT zůstatek.
      </p>
    </Modal>
  );
}
