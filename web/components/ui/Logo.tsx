import Link from "next/link";

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <path d="M9 35 24 8l15 27" fill="none" stroke="#1E6B62" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 27h16" fill="none" stroke="#1E6B62" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M5 35c9-1 12-14 21-14 6 0 9 5 17 4" fill="none" stroke="#7CF5D4" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="43" cy="25" r="2.3" fill="#1E6B62" />
    </svg>
  );
}

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 text-mist-100" aria-label="Aether Quant home">
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight">
        Aether<span className="text-aether"> Quant</span>
      </span>
    </Link>
  );
}
