import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import DateRangePicker from "../DateRangePicker";

describe("DateRangePicker", () => {
	it("calls onCancel when backdrop is clicked", async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(<DateRangePicker onApply={vi.fn()} onCancel={onCancel} />);

		const backdrop = screen.getByText("Click a date to set the start").closest(".fixed");
		expect(backdrop).not.toBeNull();
		await user.click(backdrop!);

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("calls onCancel on Escape", async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(<DateRangePicker onApply={vi.fn()} onCancel={onCancel} />);

		await user.keyboard("{Escape}");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("enables apply after selecting start and end dates", async () => {
		const user = userEvent.setup();
		const onApply = vi.fn();
		render(<DateRangePicker onApply={onApply} onCancel={vi.fn()} />);

		const day10 = screen.getAllByRole("button", { name: "10" })[0];
		const day12 = screen.getAllByRole("button", { name: "12" })[0];
		await user.click(day10);
		await user.click(day12);

		const apply = screen.getByRole("button", { name: "Apply" });
		expect((apply as HTMLButtonElement).disabled).toBe(false);
		await user.click(apply);

		expect(onApply).toHaveBeenCalledTimes(1);
	});
});
