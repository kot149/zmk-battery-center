import React from "react";

interface BatteryIconProps {
  percentage: number; // 0-100
  className?: string;
  size?: number; // Icon size (px)
}

const getBatteryColor = (percentage: number) => {
  if (percentage <= 20) return "#ef4444"; // Red
  if (percentage <= 40) return "#f59e42"; // Orange
  return "#22c55e"; // Green
};

const BatteryIcon: React.FC<BatteryIconProps> = ({ percentage, className = "", size = 28 }) => {
  // Battery frame
  const left = 2;
  const top = 4;
  const frameWidth = size * 0.85;
  const frameHeight = size * 0.48;

  // Battery terminal
  const terminalWidth = size - frameWidth;
  const terminalHeight = frameHeight * 0.5;
  const terminalLeft = left + frameWidth;
  const terminalTop = top + (frameHeight - terminalHeight) / 2;

  // Battery fill width
  const maxFillWidth = frameWidth * 0.85;
  const padding = (frameWidth - maxFillWidth) / 2;
  const fillWidth = Math.max(0, Math.min(maxFillWidth, (maxFillWidth * percentage) / 100));
  const fillHeight = frameHeight - padding * 2;
  const fillLeft = left + padding;
  const fillTop = top + padding;
  const color = getBatteryColor(percentage);

  return (
    <svg
      width={size}
      height={frameHeight}
      viewBox="0 0 32 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Battery frame */}
      <rect
        x={left}
        y={top}
        width={frameWidth}
        height={frameHeight}
        rx="10%"
        className="stroke-card-foreground/60 stroke-2 fill-none"
      />
      {/* Battery terminal */}
      <rect
        x={terminalLeft}
        y={terminalTop}
        width={terminalWidth}
        height={terminalHeight}
        rx="10%"
        className="fill-card-foreground/60"
      />
      {/* Battery fill */}
      <rect x={fillLeft} y={fillTop} width={fillWidth} height={fillHeight} rx="10%" fill={color} />
    </svg>
  );
};

export default BatteryIcon;
