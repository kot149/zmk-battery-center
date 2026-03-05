import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";

export interface DateRange {
	start: Date;
	end: Date;
}

interface DateRangePickerProps {
	/** Called when both start and end dates are selected */
	onApply: (range: DateRange) => void;
	onCancel: () => void;
	/** Initial range to display */
	initialRange?: DateRange;
}

// ── Helpers ────────────────────────────────────────────
function daysInMonth(year: number, month: number): number {
	return new Date(year, month + 1, 0).getDate();
}

function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

function isBetween(date: Date, start: Date, end: Date): boolean {
	const t = date.getTime();
	return t > start.getTime() && t < end.getTime();
}

function startOfDay(d: Date): Date {
	const r = new Date(d);
	r.setHours(0, 0, 0, 0);
	return r;
}

function endOfDay(d: Date): Date {
	const r = new Date(d);
	r.setHours(23, 59, 59, 999);
	return r;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

// ── Calendar Grid ──────────────────────────────────────
interface CalendarProps {
	year: number;
	month: number;
	selectedStart: Date | null;
	selectedEnd: Date | null;
	hoverDate: Date | null;
	onDateClick: (date: Date) => void;
	onDateHover: (date: Date | null) => void;
	onPrevMonth: () => void;
	onNextMonth: () => void;
	maxDate: Date;
}

const Calendar: React.FC<CalendarProps> = ({
	year,
	month,
	selectedStart,
	selectedEnd,
	hoverDate,
	onDateClick,
	onDateHover,
	onPrevMonth,
	onNextMonth,
	maxDate,
}) => {
	const days = daysInMonth(year, month);
	const firstDow = new Date(year, month, 1).getDay(); // 0=Sun
	const today = startOfDay(new Date());

	// Determine the effective end for highlighting
	const effectiveEnd = selectedEnd ?? hoverDate;

	// Build 6-week grid (42 cells)
	const cells: (Date | null)[] = [];
	for (let i = 0; i < firstDow; i++) cells.push(null);
	for (let d = 1; d <= days; d++) cells.push(new Date(year, month, d));
	while (cells.length < 42) cells.push(null);

	return (
		<div className="flex flex-col select-none w-72">
			{/* Month/Year header */}
			<div className="flex items-center justify-between mb-1">
				<button
					type="button"
					onClick={onPrevMonth}
					className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
					aria-label="Previous month"
				>
					<ChevronLeftIcon className="size-4" />
				</button>
				<span className="text-sm font-semibold text-foreground">
					{MONTHS[month]} {year}
				</span>
				<button
					type="button"
					onClick={onNextMonth}
					className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
					aria-label="Next month"
				>
					<ChevronRightIcon className="size-4" />
				</button>
			</div>

			{/* Weekday headers */}
			<div className="grid grid-cols-7 gap-0">
				{WEEKDAYS.map((w) => (
					<div key={w} className="text-center text-sm text-muted-foreground font-medium py-0.5">
						{w}
					</div>
				))}
			</div>

			{/* Day cells */}
			<div className="grid grid-cols-7 gap-0">
				{cells.map((date, i) => {
					if (!date) {
						return <div key={`empty-${i}`} className="h-8" />;
					}

					const isDisabled = date > maxDate;
					const isToday = isSameDay(date, today);
					const isStart = selectedStart && isSameDay(date, selectedStart);
					const isEnd = effectiveEnd && selectedStart && isSameDay(date, effectiveEnd);
					const isStartEnd = isStart && isEnd; // same day selected for both
					const isInRange =
						selectedStart &&
						effectiveEnd &&
						isBetween(
							date,
							selectedStart < effectiveEnd ? selectedStart : effectiveEnd,
							selectedStart < effectiveEnd ? effectiveEnd : selectedStart,
						);

					const isHovered = hoverDate && !isDisabled && isSameDay(date, hoverDate);

					// When hovering before the start date, the range direction is reversed
					const isReversed = selectedStart && effectiveEnd && effectiveEnd < selectedStart;

					// Outer wrapper: continuous range band (no rounded corners so it connects)
					let wrapperClass = "h-8 relative ";
					if ((isInRange || isStart || isEnd) && !isStartEnd) {
						if (isStart) {
							wrapperClass += isReversed
								? "bg-primary/35 rounded-r-full "
								: "bg-primary/35 rounded-l-full ";
						} else if (isEnd) {
							wrapperClass += isReversed
								? "bg-primary/35 rounded-l-full "
								: "bg-primary/35 rounded-r-full ";
						} else {
							wrapperClass += "bg-primary/35 ";
						}
					}

					// Inner button: the visible day circle
					let btnClass =
						"h-8 w-full text-sm flex items-center justify-center transition-colors cursor-pointer relative z-10 ";

					if (isDisabled) {
						btnClass += "text-muted-foreground/40 cursor-not-allowed ";
					} else if (isStartEnd) {
						btnClass += "bg-primary text-primary-foreground font-semibold rounded-full ";
					} else if (isStart) {
						btnClass += isReversed
							? "bg-primary text-primary-foreground font-semibold rounded-r-full "
							: "bg-primary text-primary-foreground font-semibold rounded-l-full ";
					} else if (isEnd) {
						btnClass += isReversed
							? "bg-primary text-primary-foreground font-semibold rounded-l-full "
							: "bg-primary text-primary-foreground font-semibold rounded-r-full ";
					} else if (isHovered) {
						btnClass += "bg-accent text-accent-foreground rounded-full ";
					} else if (isInRange) {
						// No extra bg on inner – the wrapper provides the band
						btnClass += "text-foreground hover:bg-accent rounded-full ";
					} else if (isToday) {
						btnClass += "border border-primary/50 text-foreground font-medium hover:bg-accent rounded-full ";
					} else {
						btnClass += "text-foreground hover:bg-accent rounded-full ";
					}

					return (
						<div key={date.toISOString()} className={wrapperClass}>
							<button
								type="button"
								className={btnClass}
								disabled={isDisabled}
								onClick={() => !isDisabled && onDateClick(date)}
								onMouseEnter={() => !isDisabled && onDateHover(date)}
								onMouseLeave={() => onDateHover(null)}
							>
								{date.getDate()}
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
};

// ── DateRangePicker ────────────────────────────────────
const DateRangePicker: React.FC<DateRangePickerProps> = ({
	onApply,
	onCancel,
	initialRange,
}) => {
	const today = useMemo(() => startOfDay(new Date()), []);

	const [selectedStart, setSelectedStart] = useState<Date | null>(
		initialRange ? startOfDay(initialRange.start) : null,
	);
	const [selectedEnd, setSelectedEnd] = useState<Date | null>(
		initialRange ? startOfDay(initialRange.end) : null,
	);
	const [hoverDate, setHoverDate] = useState<Date | null>(null);
	/** false = picking start, true = picking end */
	const [pickingEnd, setPickingEnd] = useState(false);

	const [leftYear, setLeftYear] = useState(() => {
		const base = initialRange ? initialRange.start : new Date();
		return base.getFullYear();
	});
	const [leftMonth, setLeftMonth] = useState(() => {
		const base = initialRange ? initialRange.start : new Date();
		return base.getMonth();
	});

	const prevMonth = useCallback(() => {
		setLeftMonth((m) => {
			if (m === 0) {
				setLeftYear((y) => y - 1);
				return 11;
			}
			return m - 1;
		});
	}, []);

	const nextMonth = useCallback(() => {
		setLeftMonth((m) => {
			if (m === 11) {
				setLeftYear((y) => y + 1);
				return 0;
			}
			return m + 1;
		});
	}, []);

	const handleDateClick = useCallback(
		(date: Date) => {
			if (!pickingEnd) {
				// First click: set start
				setSelectedStart(date);
				setSelectedEnd(null);
				setPickingEnd(true);
			} else {
				// Second click: set end
				let start = selectedStart!;
				let end = date;
				// Ensure start <= end
				if (end < start) {
					[start, end] = [end, start];
				}
				setSelectedStart(start);
				setSelectedEnd(end);
				setPickingEnd(false);
			}
		},
		[pickingEnd, selectedStart],
	);

	const handleApply = useCallback(() => {
		if (selectedStart && selectedEnd) {
			onApply({
				start: startOfDay(selectedStart),
				end: endOfDay(selectedEnd),
			});
		}
	}, [selectedStart, selectedEnd, onApply]);

	// Close on Escape key
	const containerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancel();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [onCancel]);

	return (
		<div
			ref={containerRef}
			className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
			onClick={(e) => {
				if (e.target === e.currentTarget) onCancel();
			}}
		>
			<div className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg p-4">
				{/* Instruction */}
				<p className="text-xs text-muted-foreground mb-2">
					{!pickingEnd
						? "Click a date to set the start"
						: "Click a date to set the end"}
				</p>

				{/* Calendar + overlapping action buttons */}
				<div className="relative">
					<Calendar
						year={leftYear}
						month={leftMonth}
						selectedStart={selectedStart}
						selectedEnd={selectedEnd}
						hoverDate={pickingEnd ? hoverDate : null}
						onDateClick={handleDateClick}
						onDateHover={setHoverDate}
						onPrevMonth={prevMonth}
						onNextMonth={nextMonth}
						maxDate={today}
					/>

					{/* Action buttons overlapping the last calendar row */}
					<div className="absolute -bottom-2 right-0 flex gap-2 z-20">
						<button
							type="button"
							onClick={onCancel}
							className="px-3 py-1 text-sm rounded-md border border-border text-foreground hover:bg-accent transition-colors"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleApply}
							disabled={!selectedStart || !selectedEnd}
							className="px-3 py-1 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							Apply
						</button>
					</div>
				</div>
			</div>
		</div>
	);
};

export default DateRangePicker;
