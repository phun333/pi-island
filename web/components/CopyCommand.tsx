"use client";

import { useState } from "react";

export default function CopyCommand({
  command,
  prefix = "$",
}: {
  command: string;
  prefix?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <button
      onClick={onCopy}
      className="group inline-flex items-center gap-1.5 font-mono text-[12px] text-[color:var(--foreground-dim)] hover:text-[color:var(--foreground)] transition-colors"
      aria-label="Copy install command"
    >
      <span className="select-none opacity-60">{prefix}</span>
      <span>{command}</span>
      <span className="opacity-40 group-hover:opacity-100 transition-opacity" aria-hidden>
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </span>
    </button>
  );
}
