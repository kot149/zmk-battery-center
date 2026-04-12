import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
	emit: vi.fn(),
	listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@tauri-apps/plugin-os", () => ({
	platform: vi.fn(() => "windows"),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
	load: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-autostart", () => ({
	enable: vi.fn(async () => undefined),
	isEnabled: vi.fn(async () => false),
	disable: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
	isPermissionGranted: vi.fn(async () => true),
	requestPermission: vi.fn(async () => "granted"),
	sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-log", () => ({
	warn: vi.fn(async () => undefined),
	debug: vi.fn(async () => undefined),
	trace: vi.fn(async () => undefined),
	info: vi.fn(async () => undefined),
	error: vi.fn(async () => undefined),
}));
