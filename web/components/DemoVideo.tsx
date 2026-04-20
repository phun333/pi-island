export default function DemoVideo() {
  return (
    <div className="relative">
      {/* Subtle stacked cards behind the frame to hint at multi-session stacking */}
      <div
        aria-hidden
        className="absolute inset-x-10 -bottom-3 h-6 rounded-b-2xl bg-[color:var(--background-muted)] border border-[color:var(--border)] opacity-70"
      />
      <div
        aria-hidden
        className="absolute inset-x-5 -bottom-6 h-6 rounded-b-2xl bg-[color:var(--background-muted)] border border-[color:var(--border)] opacity-40"
      />

      {/* Main frame */}
      <figure className="relative overflow-hidden rounded-2xl border border-[color:var(--border)] bg-[color:var(--background-muted)] shadow-[0_1px_0_rgba(0,0,0,0.02),0_12px_40px_-12px_rgba(0,0,0,0.12)]">
        {/* faux macOS chrome */}
        <div className="flex items-center gap-1.5 px-4 py-3 border-b border-[color:var(--border)] bg-white/60">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
          <span className="ml-3 text-xs text-[color:var(--foreground-dim)] font-mono">
            pi · island
          </span>
        </div>

        <video
          className="block w-full h-auto"
          src="https://github.com/phun333/pi-island/raw/main/assets/demo.mov"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        />
      </figure>
    </div>
  );
}
