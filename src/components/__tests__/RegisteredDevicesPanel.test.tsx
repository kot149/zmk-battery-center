import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RegisteredDevice } from "@/utils/appHelpers";
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
	isCollapsed: false,
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

function ControlledCollapseHarness({ initialDevices }: { initialDevices: RegisteredDevice[] }) {
	const [registeredDevices, setRegisteredDevices] = useState(initialDevices);
	const [visible, setVisible] = useState(true);

	return (
		<>
			<button type="button" onClick={() => setVisible((prev) => !prev)}>
				Toggle Panel
			</button>
			{visible ? (
				<RegisteredDevicesPanel
					registeredDevices={registeredDevices}
					setRegisteredDevices={setRegisteredDevices}
				/>
			) : null}
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

		expect(screen.getByLabelText("Disconnected")).toBeTruthy();
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

	it("commits a custom device display name via setRegisteredDevices", async () => {
		const user = userEvent.setup();
		const onSet = vi.fn();
		render(
			<RegisteredDevicesPanel registeredDevices={[sampleDevice]} setRegisteredDevices={onSet} />,
		);

		await user.click(screen.getByRole("button", { name: "Edit device display name" }));
		const field = screen.getByDisplayValue("MockBoard");
		await user.clear(field);
		await user.keyboard("Custom KB{Enter}");

		expect(onSet).toHaveBeenCalled();
		const updater = onSet.mock.calls[onSet.mock.calls.length - 1]![0] as (
			prev: RegisteredDevice[],
		) => RegisteredDevice[];
		const next = updater([sampleDevice]);
		expect(next[0].displayName).toBe("Custom KB");
		expect(next[0].name).toBe("MockBoard");
	});

	it("commits a custom battery part label and persists via setRegisteredDevices", async () => {
		const user = userEvent.setup();
		const onSet = vi.fn();
		const dual: RegisteredDevice = {
			...sampleDevice,
			batteryInfos: [
				{ battery_level: 40, user_description: null },
				{ battery_level: 60, user_description: "Peripheral" },
			],
		};
		render(
			<RegisteredDevicesPanel registeredDevices={[dual]} setRegisteredDevices={onSet} />,
		);

		const editButtons = screen.getAllByRole("button", { name: "Edit battery part label" });
		expect(screen.getByText("Peripheral")).toBeTruthy();
		await user.click(editButtons[1]);

		const field = screen.getByDisplayValue("Peripheral");
		await user.clear(field);
		await user.keyboard("Right hand{Enter}");

		expect(onSet).toHaveBeenCalled();
		const updater = onSet.mock.calls[0][0] as (prev: RegisteredDevice[]) => RegisteredDevice[];
		const next = updater([dual]);
		expect(next[0].batteryPartLabels).toEqual({ Peripheral: "Right hand" });
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

	it("keeps collapse state when remounted with controlled state", async () => {
		const user = userEvent.setup();
		render(<ControlledCollapseHarness initialDevices={[sampleDevice]} />);

		expect(screen.getByText("55%")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Collapse device" }));
		expect(screen.queryByText("55%")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Toggle Panel" }));
		expect(screen.queryByText("MockBoard")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Toggle Panel" }));
		expect(screen.queryByText("55%")).toBeNull();
		expect(screen.getByRole("button", { name: "Expand device" })).toBeTruthy();
	});

	it("uses container gap without margin for collapsed spacing", async () => {
		const user = userEvent.setup();
		render(<ControlledCollapseHarness initialDevices={[sampleDevice]} />);

		const collapseButton = screen.getByRole("button", { name: "Collapse device" });
		const expandedHeaderRow = collapseButton.closest("div");
		const expandedContentRow = screen.getByTestId("device-battery-row-dev-1-Central").parentElement;
		const expandedStack = expandedHeaderRow?.parentElement;
		expect(expandedStack?.className).toContain("gap-2");
		expect(expandedStack?.children).toHaveLength(2);
		expect(expandedStack?.children[0]).toBe(expandedHeaderRow);
		expect(expandedStack?.children[1]).toBe(expandedContentRow);

		await user.click(collapseButton);

		const expandButton = screen.getByRole("button", { name: "Expand device" });
		const collapsedHeaderRow = expandButton.closest("div");
		const collapsedStack = collapsedHeaderRow?.parentElement;
		expect(collapsedStack?.className).toContain("gap-2");
		expect(collapsedStack?.children).toHaveLength(1);
	});
});
