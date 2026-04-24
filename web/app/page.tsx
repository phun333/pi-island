import Sidebar from "@/components/Sidebar";
import CopyCommand from "@/components/CopyCommand";
import DemoVideo from "@/components/DemoVideo";
import DictionaryTerm from "@/components/DictionaryTerm";

export default function Home() {
  return (
    <div className="mx-auto flex max-w-[1040px] gap-4">
      <Sidebar />

      <main className="flex-1 px-5 sm:px-8 lg:px-10 py-10 lg:py-14 max-w-[640px]">
        {/* ======================= HERO / OVERVIEW ======================= */}
        <section id="overview" className="scroll-mt-16">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <h1 className="font-sans font-semibold text-[30px] sm:text-[34px] lg:text-[38px] leading-[1.1] tracking-tight max-w-[14ch]">
              <DictionaryTerm
                word="Dynamic Island"
                phonetic="/daɪˈnæmɪk ˈaɪlənd/"
                pos="noun"
                definition="A pill-shaped, interactive region at the top of the screen that surfaces live activities and status. Introduced by Apple in 2022."
              >
                Dynamic Island.
              </DictionaryTerm>
              <br />
              For your{" "}
              <DictionaryTerm
                word="agent"
                phonetic="/ˈeɪdʒənt/"
                pos="noun"
                definition="An autonomous program that perceives its environment and acts toward a goal — here, an AI coding assistant living in your terminal."
              >
                agent.
              </DictionaryTerm>
            </h1>

            <div className="pt-2 shrink-0">
              <CopyCommand command="pi install npm:pi-island" />
            </div>
          </div>

          <p className="mt-5 text-[14px] leading-[1.6] text-[color:var(--foreground-dim)] max-w-[58ch]">
            pi-island turns the top of your screen into a live status capsule
            for the{" "}
            <a
              href="https://pi.dev"
              className="text-[color:var(--foreground)] underline underline-offset-2 decoration-[color:var(--border-strong)] hover:decoration-[color:var(--accent)]"
              target="_blank"
              rel="noreferrer"
            >
              pi coding agent
            </a>
            . Native on macOS (WKWebView) and Windows (WebView2),
            notch-aware on MacBooks, one row per session — pinned,
            stacked, and always in sight.
          </p>

          {/* Demo */}
          <div className="mt-10">
            <DemoVideo />
          </div>
        </section>

        {/* ======================= INSTALL ======================= */}
        <section id="install" className="mt-16 scroll-mt-16">
          <div className="flex items-end justify-between gap-4 border-b border-[color:var(--border)] pb-2 mb-5">
            <h2 className="font-sans font-semibold text-[17px] tracking-tight">Install</h2>
            <span className="text-[10px] text-[color:var(--foreground-dim)] uppercase tracking-wider">
              macOS / Windows
            </span>
          </div>

          <p className="text-[14px] text-[color:var(--foreground-dim)] leading-relaxed mb-4">
            Requires{" "}
            <a
              href="https://pi.dev"
              className="text-[color:var(--link)] hover:text-[color:var(--link-hover)]"
              target="_blank"
              rel="noreferrer"
            >
              pi
            </a>{" "}
            plus the toolchain for your platform — Xcode Command Line
            Tools on <strong className="text-[color:var(--foreground)]">macOS</strong>,
            the .NET 8 SDK on <strong className="text-[color:var(--foreground)]">Windows</strong>.
          </p>

          <div className="space-y-2 font-mono text-[13px]">
            <div className="rounded-lg bg-[color:var(--background-muted)] border border-[color:var(--border)] px-4 py-2.5 text-[color:var(--foreground)]">
              <span className="text-[color:var(--foreground-dim)] select-none">macOS $ </span>
              xcode-select --install
            </div>
            <div className="rounded-lg bg-[color:var(--background-muted)] border border-[color:var(--border)] px-4 py-2.5 text-[color:var(--foreground)]">
              <span className="text-[color:var(--foreground-dim)] select-none">Windows &gt; </span>
              winget install Microsoft.DotNet.SDK.8
            </div>
            <div className="rounded-lg bg-[color:var(--background-muted)] border border-[color:var(--border)] px-4 py-2.5 text-[color:var(--foreground)]">
              <span className="text-[color:var(--foreground-dim)] select-none">$ </span>
              pi install npm:pi-island
            </div>
          </div>
        </section>

        {/* ======================= SETTINGS ======================= */}
        <section id="settings" className="mt-16 scroll-mt-16">
          <div className="flex items-end justify-between gap-4 border-b border-[color:var(--border)] pb-2 mb-5">
            <h2 className="font-sans font-semibold text-[17px] tracking-tight">Settings</h2>
            <span className="text-[10px] text-[color:var(--foreground-dim)] uppercase tracking-wider">
              inside any pi session
            </span>
          </div>

          <p className="text-[14px] text-[color:var(--foreground-dim)] leading-relaxed mb-5">
            Type <code className="font-mono text-[12.5px] text-[color:var(--foreground)] bg-[color:var(--background-muted)] px-1.5 py-0.5 rounded border border-[color:var(--border)]">/island</code>{" "}
            to open the settings panel. Cycle any row with Enter or Space.
            Choices persist in{" "}
            <code className="font-mono text-[12px] text-[color:var(--foreground-dim)]">~/.pi/pi-island.json</code>.
          </p>

          <div className="grid sm:grid-cols-2 gap-3">
            <CommandCard
              name="Visibility"
              desc="enabled / disabled — show or hide the capsule. Remembers your choice."
            />
            <CommandCard
              name="Size"
              desc="small / medium / large / xlarge — row height and font scale together. Live, no restart."
            />
            <CommandCard
              name="Screen"
              desc="primary / active / 2 / 3 — pick a monitor. primary = menu-bar display, active = follow mouse."
            />
            <CommandCard
              name="Notch wrap"
              desc="auto / normal / notch — wrap the MacBook notch automatically, or force it on/off."
            />
          </div>

          <p className="mt-5 text-[13px] text-[color:var(--foreground-dim)] leading-relaxed">
            Skip the menu for muscle memory:{" "}
            <code className="font-mono text-[12.5px] text-[color:var(--foreground)]">/island size large</code>,{" "}
            <code className="font-mono text-[12.5px] text-[color:var(--foreground)]">/island screen primary</code>,{" "}
            <code className="font-mono text-[12.5px] text-[color:var(--foreground)]">/island notch notch</code>,{" "}
            <code className="font-mono text-[12.5px] text-[color:var(--foreground)]">/island off</code>.
          </p>

          <p className="mt-3 text-[13px] text-[color:var(--foreground-dim)] leading-relaxed">
            Run pi in multiple terminals — each session gets its own row,
            stacked into one continuous capsule.
          </p>
        </section>

        {/* ======================= HOW IT WORKS ======================= */}
        <section id="how-it-works" className="mt-16 scroll-mt-16">
          <div className="flex items-end justify-between gap-4 border-b border-[color:var(--border)] pb-2 mb-5">
            <h2 className="font-sans font-semibold text-[17px] tracking-tight">How it works</h2>
          </div>

          <ol className="space-y-3.5">
            <Step num={1} bold="A native host per platform" rest="renders a borderless, click-through WebView pinned above every window — Swift + WKWebView on macOS, C# + WebView2 on Windows." />
            <Step num={2} bold="pi's extension API" rest="streams each turn's status over a local socket to the host." />
            <Step num={3} bold="Every pi session" rest="gets its own row. Rows stack into a single capsule, sized to the longest row." />
            <Step num={4} bold="Notch detection" rest="on MacBooks with a notch, the capsule splits to wrap around it automatically — or force it on/off from the settings menu." />
            <Step num={5} bold="Zero chrome." rest="No dock icon, no taskbar entry, no Stage Manager clutter — it just lives at the top." />
          </ol>

        </section>

        {/* ======================= FOOTER ======================= */}
        <footer className="mt-20 pt-6 border-t border-[color:var(--border)] text-[12px] text-[color:var(--foreground-dim)] flex flex-wrap items-center justify-between gap-3">
          <div>
            MIT License ·{" "}
            <a
              href="https://github.com/phun333/pi-island"
              className="hover:text-[color:var(--foreground)] underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              phun333/pi-island
            </a>
          </div>
          <div>
            Built on{" "}
            <a
              href="https://pi.dev"
              className="hover:text-[color:var(--foreground)] underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              pi.dev
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}

function CommandCard({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-white px-4 py-3.5 hover:border-[color:var(--accent)] transition-colors">
      <code className="font-mono text-[13px] font-medium text-[color:var(--foreground)]">
        {name}
      </code>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-[color:var(--foreground-dim)]">
        {desc}
      </p>
    </div>
  );
}

function Step({
  num,
  bold,
  rest,
}: {
  num: number;
  bold: string;
  rest: string;
}) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 font-mono text-[12px] text-[color:var(--foreground-dim)] pt-0.5 w-4">
        {num}.
      </span>
      <p className="text-[13.5px] leading-[1.55]">
        <strong className="text-[color:var(--foreground)] font-medium">
          {bold}
        </strong>{" "}
        <span className="text-[color:var(--foreground-dim)]">{rest}</span>
      </p>
    </li>
  );
}
