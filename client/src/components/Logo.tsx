export function EchoMark({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="4.5" fill="var(--color-signal)" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="var(--color-signal)" strokeOpacity=".5" strokeWidth="1.6" />
      <circle cx="16" cy="16" r="14.2" fill="none" stroke="var(--color-signal)" strokeOpacity=".22" strokeWidth="1.2" />
    </svg>
  );
}

export function EchoLogo() {
  return (
    <div className="flex items-center gap-2.5">
      <EchoMark className="h-7 w-7" />
      <span className="font-mono text-[15px] font-medium tracking-[0.28em] text-ink-100">ECHO</span>
    </div>
  );
}
