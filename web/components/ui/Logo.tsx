import Link from "next/link";

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 2 30 29H2Z" fill="none" stroke="#2fbf9b" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M7 22c4-1 6-8 9-8s4 5 9 4" fill="none" stroke="#7cf5d4" strokeWidth="2" strokeLinecap="round" />
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
