type Props = {
  children: React.ReactNode;
  word: string;
  phonetic: string;
  pos: string; // part of speech, e.g. "noun"
  definition: string;
  etym?: string;
};

/**
 * Redhouse-dictionary-style term. Inline accent-underlined word that
 * reveals a little definition card on hover/focus.
 */
export default function DictionaryTerm({
  children,
  word,
  phonetic,
  pos,
  definition,
  etym,
}: Props) {
  return (
    <span className="relative group mark-underline cursor-help" tabIndex={0}>
      {children}

      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-[calc(100%+0.55rem)] z-30
                   w-[280px] max-w-[85vw]
                   origin-top-left
                   opacity-0 translate-y-1 scale-[0.98]
                   group-hover:opacity-100 group-hover:translate-y-0 group-hover:scale-100
                   group-focus-within:opacity-100 group-focus-within:translate-y-0 group-focus-within:scale-100
                   transition-[opacity,transform] duration-150 ease-out
                   rounded-lg border border-[color:var(--border)] bg-white
                   shadow-[0_10px_28px_-10px_rgba(0,0,0,0.22)]
                   px-4 py-3 text-left
                   whitespace-normal"
      >
        {/* little notch pointing up toward the word */}
        <span
          aria-hidden
          className="absolute -top-[5px] left-5 h-2.5 w-2.5 rotate-45 bg-white border-l border-t border-[color:var(--border)]"
        />

        <span className="flex items-baseline gap-2 flex-wrap">
          <span className="font-sans font-semibold text-[14px] leading-none text-[color:var(--foreground)]">
            {word}
          </span>
          <span className="font-mono text-[10.5px] text-[color:var(--foreground-dim)]">
            {phonetic}
          </span>
        </span>

        <span className="mt-1 block font-sans text-[11px] text-[color:var(--accent)]">
          {pos}
        </span>

        <span className="mt-2 block text-[12.5px] leading-[1.55] text-[color:var(--foreground-dim)] font-sans">
          {definition}
        </span>

        {etym && (
          <span className="mt-2 block text-[11px] leading-[1.5] text-[color:var(--foreground-dim)] font-sans border-t border-[color:var(--border)] pt-2">
            {etym}
          </span>
        )}
      </span>
    </span>
  );
}
