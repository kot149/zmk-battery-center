import React, { useEffect, useRef, useState } from "react";
import Button from "./Button";
import { XMarkIcon } from "@heroicons/react/24/outline";

interface ModalProps {
	open: boolean;
	onClose: () => void;
	title?: string;
	isLoading?: boolean;
	error?: string;
	loadingText?: string;
	children?: React.ReactNode;
	showCloseButton?: boolean;
}

const Modal: React.FC<ModalProps> = ({
	open,
	onClose,
	title,
	isLoading = false,
	error,
	loadingText = "Loading...",
	children,
	showCloseButton = true,
}) => {
	const [isClosing, setIsClosing] = useState(false);
	const [animate, setAnimate] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
	const animateTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

	const shouldShow = open || isClosing;

	useEffect(() => {
		if (open) {
			setIsClosing(false);
			animateTimeoutRef.current = setTimeout(() => setAnimate(true), 10);
		} else if (shouldShow) {
			setAnimate(false);
			setIsClosing(true);
			timeoutRef.current = setTimeout(() => setIsClosing(false), 200);
		}
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			if (animateTimeoutRef.current) clearTimeout(animateTimeoutRef.current);
		};
	}, [open, shouldShow]);
	return (
		shouldShow ? (
			<div
				className={`fixed inset-0 z-50 flex items-center justify-center bg-background/80 rounded-lg transition-opacity duration-200 ${animate ? 'opacity-100' : 'opacity-0'}`}
				onClick={onClose}
			>
				<div
					className={`bg-card rounded-lg shadow-lg p-6 min-w-60 relative transform transition-all duration-200 ${animate ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}
					onClick={e => e.stopPropagation()}
				>
					{showCloseButton && (
						<Button
							className="absolute top-4 right-4 w-10 h-10 rounded-lg bg-transparent hover:bg-muted flex items-center justify-center text-xl font-bold text-foreground !p-0"
							onClick={onClose}
							aria-label="Close"
						>
							<XMarkIcon className="size-5 text-foreground" />
						</Button>
					)}
					{title && <h2 className="text-foreground text-lg mb-4">{title}</h2>}
					{error && <div className="w-65 bg-destructive/40 text-destructive-foreground px-4 py-2 rounded-lg shadow-lg">{error}</div>}
					{isLoading ? (
						<div className="flex justify-center items-center py-8">
							<div className="loader border-4 border-primary border-t-transparent rounded-full w-10 h-10 animate-spin"></div>
							<span className="ml-4 text-foreground">{loadingText}</span>
						</div>
					) : (
						!error && children
					)}
				</div>
			</div>
		) : null
	);
};

export default Modal;
