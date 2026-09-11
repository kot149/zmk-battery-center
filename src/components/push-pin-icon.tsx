import type { SVGProps } from "react";

type PushPinIconProps = SVGProps<SVGSVGElement> & {
  pinned: boolean;
};

export default function PushPinIcon({ pinned, className, ...props }: PushPinIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      data-pinned={pinned}
      className={className ?? ""}
      {...props}
    >
      <g transform="rotate(45 12 12)">
        {/* Outline (always shown, pinned state is expressed by slash only) */}
        <g
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8.7 4.75h6.6" />
          <path d="M10 4.75v4.6l-2.6 2.9c-.22.24-.28.58-.16.88.12.29.41.48.73.48h8.06c.32 0 .61-.19.73-.48.12-.3.06-.64-.16-.88L14 9.35v-4.6" />
          <path d="M12 13.6v4.25" />
        </g>
      </g>

      {/* Pin slash (shown only when pinned) */}
      {pinned && (
        <path
          d="M5.1 5.1 18.9 18.9"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
