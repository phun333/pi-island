import Link from "next/link";

const sections = [
  { href: "#overview", label: "Overview", active: true },
  { href: "#install", label: "Install" },
  { href: "#settings", label: "Settings" },
  { href: "#how-it-works", label: "How it works" },
];

const resources = [
  { href: "https://github.com/phun333/pi-island", label: "GitHub" },
  {
    href: "https://www.npmjs.com/package/pi-island",
    label: "npm",
  }
];

export default function Sidebar() {
  return (
    <aside className="hidden lg:flex lg:w-52 xl:w-56 shrink-0 flex-col gap-8 px-6 py-10 sticky top-0 h-screen">
      {/* Logo */}
      <Link href="/" className="inline-flex items-baseline gap-1 group not-italic">
        <span className="font-sans text-[20px] font-semibold leading-none text-[color:var(--accent)] tracking-tight not-italic">
          pi
        </span>
        <span className="font-sans text-[20px] font-semibold leading-none tracking-tight not-italic">
          ·island
        </span>
      </Link>

      {/* Sections */}
      <nav className="flex flex-col gap-0.5 text-[13px]">
        {sections.map((s) => (
          <a
            key={s.href}
            href={s.href}
            className={
              s.active
                ? "text-[color:var(--foreground)] font-medium py-1"
                : "text-[color:var(--foreground-dim)] hover:text-[color:var(--foreground)] transition-colors py-1"
            }
          >
            {s.label}
          </a>
        ))}
      </nav>

      {/* Resources */}
      <div className="flex flex-col gap-0.5 text-[13px]">
        <div className="text-[color:var(--foreground-dim)] text-[10px] uppercase tracking-wider mb-1.5">
          Resources
        </div>
        {resources.map((r) => (
          <a
            key={r.href}
            href={r.href}
            target="_blank"
            rel="noreferrer"
            className="text-[color:var(--foreground-dim)] hover:text-[color:var(--foreground)] transition-colors py-1"
          >
            {r.label}
          </a>
        ))}
      </div>

      {/* Version footer */}
      <div className="flex items-center gap-2 text-[11px] text-[color:var(--foreground-dim)]">
        <a
          href="https://github.com/phun333/pi-island/releases"
          className="hover:text-[color:var(--foreground)] transition-colors underline underline-offset-2 decoration-dotted"
        >
          v0.2.0
        </a>
        <span>·</span>
        <a
          href="https://github.com/phun333/pi-island"
          aria-label="GitHub repository"
          className="hover:text-[color:var(--foreground)] transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
          </svg>
        </a>
      </div>
    </aside>
  );
}
