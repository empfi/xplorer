export default function AppLogo({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="xp_logo_bg" x1="12" y1="12" x2="116" y2="116" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0080FF" />
          <stop offset="100%" stopColor="#002D8C" />
        </linearGradient>
        <linearGradient id="xp_logo_x1" x1="37" y1="37" x2="91" y2="91" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#E0F2FE" />
        </linearGradient>
        <linearGradient id="xp_logo_x2" x1="91" y1="37" x2="37" y2="91" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#0284C7" />
        </linearGradient>
      </defs>
      <rect x="12" y="12" width="104" height="104" rx="26" fill="url(#xp_logo_bg)" />
      <rect x="12.75" y="12.75" width="102.5" height="102.5" rx="25.25" stroke="#BAE6FD" strokeOpacity="0.45" strokeWidth="1.5" />
      <path d="M37 37L91 91" stroke="url(#xp_logo_x1)" strokeWidth="13.5" strokeLinecap="round" />
      <path d="M91 37L37 91" stroke="url(#xp_logo_x2)" strokeWidth="13.5" strokeLinecap="round" />
      <circle cx="64" cy="64" r="4.5" fill="#FFFFFF" />
    </svg>
  );
}
