import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RegisteredDevice } from "@/App";
import RegisteredDevicesPanel from "../RegisteredDevicesPanel";

vi.mock("../BatteryHistoryChart", () => ({
	default: ({ onClose }: { onClose: () => void }) => (
		<button type="button" onClick={onClose} aria-label="Close mocked chart">
			Close Chart
		</button>
	),
}));

const sampleDevice: RegisteredDevice = {
	id: "dev-1",
	name: "MockBoard",
	isDisconnected: false,
	batteryInfos: [{ battery_level: 55, user_description: "Central" }],
};

function Harness({ initialDevices }: { initialDevices: RegisteredDevice[] }) {
	const [registeredDevices, setRegisteredDevices] = useState(initialDevices);
	return (
		<>
			<RegisteredDevicesPanel registeredDevices={registeredDevices} setRegisteredDevices={setRegisteredDevices} />
			<div data-testid="device-count">{registeredDevices.length}</div>
		</>
	);
}

async function openDeviceMenu(user: ReturnType<typeof userEvent.setup>, deviceName: string) {
	const row = screen.getByText(deviceName).closest(".group");
	expect(row).not.toBeNull();
	await user.hover(row!);
	await user.click(within(row as HTMLElement).getByRole("button", { name: "Open menu" }));
}

describe("RegisteredDevicesPanel", () => {
	it("renders device rows with battery percentage", () => {
		render(<RegisteredDevicesPanel registeredDevices={[sampleDevice]} setRegisteredDevices={vi.fn()} />);
		expect(screen.getByText("MockBoard")).toBeTruthy();
		expect(screen.getByTestId("device-battery-level-dev-1-Central").textContent).toBe("55%");
	});

	it("removes a device when Remove is chosen from the menu", async () => {
		const user = userEvent.setup();
		render(<Harness initialDevices={[sampleDevice]} />);

		await openDeviceMenu(user, "MockBoard");
		await user.click(screen.getByRole("button", { name: "Remove" }));

		expect(screen.getByTestId("device-count").textContent).toBe("0");
	});

	it("calls onRemoveDevice when provided instead of filtering locally", async () => {
		const user = userEvent.setup();
		const onRemoveDevice = vi.fn();
		render(
			<RegisteredDevicesPanel
				registeredDevices={[sampleDevice]}
				setRegisteredDevices={vi.fn()}
				onRemoveDevice={onRemoveDevice}
			/>,
		);

		await openDeviceMenu(user, "MockBoard");
		await user.click(screen.getByRole("button", { name: "Remove" }));

		expect(onRemoveDevice).toHaveBeenCalledWith(sampleDevice);
	});

	it("renders disconnected badge when device is marked disconnected", () => {
		render(
			<RegisteredDevicesPanel
				registeredDevices={[{ ...sampleDevice, isDisconnected: true }]}
				setRegisteredDevices={vi.fn()}
			/>,
		);

		expect(screen.getByText("disconnected")).toBeTruthy();
	});

	it("renders 'No battery information' when batteryInfos is empty", () => {
		render(
			<RegisteredDevicesPanel
				registeredDevices={[{ ...sampleDevice, batteryInfos: [] }]}
				setRegisteredDevices={vi.fn()}
			/>,
		);

		expect(screen.getByText("No battery information")).toBeTruthy();
	});

	it("renders N/A when battery level is null", () => {
		render(
			<RegisteredDevicesPanel
				registeredDevices={[
					{ ...sampleDevice, batteryInfos: [{ battery_level: null, user_description: "Central" }] },
				]}
				setRegisteredDevices={vi.fn()}
			/>,
		);

		expect(screen.getByTestId("device-battery-level-dev-1-Central").textContent).toBe("N/A");
	});

	it("moves a device up when Move Up is clicked", async () => {
		const user = userEvent.setup();
		const first: RegisteredDevice = { ...sampleDevice, id: "dev-a", name: "Alpha" };
		const second: RegisteredDevice = { ...sampleDevice, id: "dev-b", name: "Beta" };
		render(<Harness initialDevices={[first, second]} />);

		await openDeviceMenu(user, "Beta");
		await user.click(screen.getByRole("button", { name: "Move Up" }));

		const names = screen
			.getAllByText(/Alpha|Beta/)
			.map((el) => el.textContent)
			.filter((v): v is string => !!v);
		expect(names.slice(0, 2)).toEqual(["Beta", "Alpha"]);
	});

	it("moves a device down when Move Down is clicked", async () => {
		const user = userEvent.setup();
		const first: RegisteredDevice = { ...sampleDevice, id: "dev-a", name: "Alpha" };
		const second: RegisteredDevice = { ...sampleDevice, id: "dev-b", name: "Beta" };
		render(<Harness initialDevices={[first, second]} />);

		await openDeviceMenu(user, "Alpha");
		await user.click(screen.getByRole("button", { name: "Move Down" }));

		const names = screen
			.getAllByText(/Alpha|Beta/)
			.map((el) => el.textContent)
			.filter((v): v is string => !!v);
		expect(names.slice(0, 2)).toEqual(["Beta", "Alpha"]);
	});

	it("closes the menu when clicking outside overlay", async () => {
		const user = userEvent.setup();
		render(<RegisteredDevicesPanel registeredDevices={[sampleDevice]} setRegisteredDevices={vi.fn()} />);

		await openDeviceMenu(user, "MockBoard");
		expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();

		const overlay = document.querySelector(".fixed.inset-0.z-0") as HTMLElement | null;
		expect(overlay).not.toBeNull();
		await user.click(overlay!);
		expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
	});

	it("opens and closes chart while notifying parent callback", async () => {
		const user = userEvent.setup();
		const onChartOpenChange = vi.fn();
		render(
			<RegisteredDevicesPanel
				registeredDevices={[sampleDevice]}
				setRegisteredDevices={vi.fn()}
				onChartOpenChange={onChartOpenChange}
			/>,
		);

		const row = screen.getByText("MockBoard").closest(".group");
		expect(row).not.toBeNull();
		await user.hover(row!);
		await user.click(screen.getByRole("button", { name: "Show battery history chart" }));

		expect(screen.getByRole("button", { name: "Close mocked chart" })).toBeTruthy();
		expect(onChartOpenChange).toHaveBeenCalledWith(true);

		await user.click(screen.getByRole("button", { name: "Close mocked chart" }));
		expect(onChartOpenChange).toHaveBeenCalledWith(false);
	});
});
