import React from "react";
import Button from "./Button";

export interface TopRightButton {
	icon: React.ReactNode;
	onClick: () => void;
	ariaLabel: string;
	disabled?: boolean;
}

interface TopRightButtonsProps {
	buttons: TopRightButton[];
}

/**
 * A shared top-right button bar used across screens (main, settings, etc.)
 * to keep the icon positions consistent.
 */
const TopRightButtons: React.FC<TopRightButtonsProps> = ({ buttons }) => {
	return (
		<div className="flex flex-row ml-auto justify-end">
			{buttons.map((btn) => (
				<Button
					key={btn.ariaLabel}
					className="w-10 h-10 rounded-lg bg-transparent hover:bg-secondary flex items-center justify-center text-2xl !p-0 !px-0 !py-0 text-foreground disabled:!text-muted-foreground disabled:hover:bg-transparent relative z-10"
					onClick={btn.onClick}
					aria-label={btn.ariaLabel}
					disabled={btn.disabled}
				>
					{btn.icon}
				</Button>
			))}
		</div>
	);
};

export default TopRightButtons;
