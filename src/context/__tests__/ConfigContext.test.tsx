import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConfigProvider, useConfigContext } from "../ConfigContext";
import { ThemeProvider } from "../theme-provider";
import * as configModule from "../../utils/config";

const mockEmit = vi.fn();
const mockListen = vi.fn();
const mockUnlisten = vi.fn();
let updateConfigHandler: ((e: { payload: Partial<configModule.Config> }) => void) | undefined;

vi.mock("@tauri-apps/api/event", () => ({
	emit: (...args: unknown[]) => mockEmit(...args),
	listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("../../utils/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../utils/config")>();
	return {
		...actual,
		loadSavedConfig: vi.fn(),
		setConfig: vi.fn(),
	};
});

vi.mock("@/utils/log", () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}));

function ConfigDisplay() {
	const { config, isConfigLoaded } = useConfigContext();
	return (
		<div>
			<span data-testid="loaded">{isConfigLoaded ? "yes" : "no"}</span>
			<span data-testid="theme">{config.theme}</span>
			<span data-testid="fetchInterval">{String(config.fetchInterval)}</span>
		</div>
	);
}

function MissingProviderProbe() {
	useConfigContext();
	return null;
}

function UpdateButton() {
	const { setConfig } = useConfigContext();
	return (
		<button
			type="button"
			onClick={() => {
				setConfig((prev) => ({ ...prev, autoStart: true }));
			}}
		>
			Update
		</button>
	);
}

function renderWithProviders(children: ReactNode) {
	return render(
		<ThemeProvider defaultTheme="dark">
			<ConfigProvider>{children}</ConfigProvider>
		</ThemeProvider>,
	);
}

describe("ConfigContext", () => {
	beforeEach(() => {
		vi.mocked(configModule.loadSavedConfig).mockResolvedValue(configModule.defaultConfig);
		vi.mocked(configModule.setConfig).mockResolvedValue(undefined);
		mockEmit.mockReset();
		mockEmit.mockResolvedValue(undefined);
		mockListen.mockReset();
		mockUnlisten.mockReset();
		updateConfigHandler = undefined;
		mockListen.mockImplementation(async (event: string, handler: (e: { payload: Partial<configModule.Config> }) => void) => {
			if (event === "update-config") {
				updateConfigHandler = handler;
			}
			return mockUnlisten;
		});
	});

	it("loads saved config and exposes values after load", async () => {
		vi.mocked(configModule.loadSavedConfig).mockResolvedValue({
			...configModule.defaultConfig,
			theme: "light",
		});

		renderWithProviders(<ConfigDisplay />);

		await waitFor(() => {
			expect(screen.getByTestId("loaded").textContent).toBe("yes");
		});
		expect(screen.getByTestId("theme").textContent).toBe("light");
		expect(mockEmit).toHaveBeenCalledWith("config-changed", expect.objectContaining({ theme: "light" }));
	});

	it("merges update-config payload and persists without emitting config-changed again", async () => {
		vi.mocked(configModule.loadSavedConfig).mockResolvedValue({
			...configModule.defaultConfig,
			theme: "dark",
		});

		renderWithProviders(<ConfigDisplay />);

		await waitFor(() => {
			expect(screen.getByTestId("loaded").textContent).toBe("yes");
		});

		expect(updateConfigHandler).toBeDefined();

		mockEmit.mockClear();
		await act(async () => {
			updateConfigHandler!({ payload: { autoStart: true } });
		});

		await waitFor(() => {
			expect(configModule.setConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					...configModule.defaultConfig,
					theme: "dark",
					autoStart: true,
				}),
			);
		});

		expect(mockEmit).not.toHaveBeenCalledWith("config-changed", expect.anything());
	});

	it("throws when useConfigContext is used outside ConfigProvider", () => {
		expect(() => {
			render(<MissingProviderProbe />);
		}).toThrow("useConfigContext must be used within a ConfigProvider");
	});

	it("persists user-triggered updates and emits config-changed", async () => {
		renderWithProviders(<UpdateButton />);

		await waitFor(() => {
			expect(configModule.loadSavedConfig).toHaveBeenCalled();
		});

		mockEmit.mockClear();
		await act(async () => {
			screen.getByRole("button", { name: "Update" }).click();
		});

		await waitFor(() => {
			expect(configModule.setConfig).toHaveBeenCalledWith(
				expect.objectContaining({ autoStart: true }),
			);
		});
		expect(mockEmit).toHaveBeenCalledWith(
			"config-changed",
			expect.objectContaining({ autoStart: true }),
		);
	});

	it("cleans up update-config listener on unmount", async () => {
		const view = renderWithProviders(<ConfigDisplay />);

		await waitFor(() => {
			expect(mockListen).toHaveBeenCalledWith("update-config", expect.any(Function));
		});

		view.unmount();
		await waitFor(() => {
			expect(mockUnlisten).toHaveBeenCalledTimes(1);
		});
	});
});
