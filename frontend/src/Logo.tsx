export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor="#7c8cf8" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="url(#logo-g)" />
      <path d="M13.5 5.5 8 13h3.2L10 18.5 16 10.5h-3.4l1-5Z" fill="#fff" />
    </svg>
  );
}
