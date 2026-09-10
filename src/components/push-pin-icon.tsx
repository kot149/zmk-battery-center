import type { SVGProps } from "react";

type PushPinIconProps = SVGProps<SVGSVGElement> & {
  pinned: boolean;
};

export default function PushPinIcon({ pinned, className, ...props }: PushPinIconProps) {
  const outlineClass = pinned ? "opacity-0" : "opacity-100";

  const fillClass = pinned ? "opacity-100" : "opacity-0";

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      data-pinned={pinned}
      className={`group ${className ?? ""}`}
      {...props}
    >
      <g transform="rotate(45 12 12)">
        {/* Outline */}
        <g
          className={`transition-opacity duration-150 ${outlineClass}`}
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8.7 4.75h6.6" />
          <path d="M10 4.75v4.6l-2.6 2.9c-.22.24-.28.58-.16.88.12.29.41.48.73.48h8.06c.32 0 .61-.19.73-.48.12-.3.06-.64-.16-.88L14 9.35v-4.6" />
          <path d="M12 13.6v4.25" />
        </g>

        {/* Filled */}
        <path
          className={`transition-opacity duration-150 ${fillClass}`}
          fill="currentColor"
          d="M8.7 3.95a.8.8 0 0 0 0 1.6h.5v3.5L6.82 11.7a1.58 1.58 0 0 0 1.17 2.65h3.21v3.5a.8.8 0 1 0 1.6 0v-3.5h3.21a1.58 1.58 0 0 0 1.17-2.65L14.8 9.05v-3.5h.5a.8.8 0 0 0 0-1.6H8.7Z"
        />
      </g>

      {/* Unpin slash */}
      {pinned && (
        <path
          className="opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          d="M5.1 5.1 18.9 18.9"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
