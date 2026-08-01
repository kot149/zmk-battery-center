import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationType } from "../config";
import { notifyBatteryEdgeTransitions } from "../batteryEdgeNotification";

const { mockSendNotification } = vi.hoisted(() => ({
	mockSendNotification: vi.fn(async (_message: string) => true),
}));

vi.mock("@/utils/notification", () => ({
	sendNotification: (message: string) => mockSendNotification(message),
}));

const notificationTypes = {
	[NotificationType.LowBattery]: false,
	[NotificationType.HighBattery]: false,
	[NotificationType.Connected]: false,
	[NotificationType.Disconnected]: false,
};

describe("battery edge notifications", () => {
	beforeEach(() => {
		mockSendNotification.mockClear();
	});

	it.each([
		{
			type: NotificationType.LowBattery,
			prevBatteryInfos: [
				{ battery_level: 50, user_description: "Central" },
				{ battery_level: 30, user_description: "Peripheral" },
			],
			newBatteryInfos: [
				{ battery_level: 50, user_description: "Central" },
				{ battery_level: 20, user_description: "Peripheral" },
			],
			threshold: 20,
			verb: "dropped below",
			expected: "My Keyboard Right battery dropped below 20%.",
		},
		{
			type: NotificationType.HighBattery,
			prevBatteryInfos: [
				{ battery_level: 50, user_description: "Central" },
				{ battery_level: 70, user_description: "Peripheral" },
			],
			newBatteryInfos: [
				{ battery_level: 50, user_description: "Central" },
				{ battery_level: 80, user_description: "Peripheral" },
			],
			threshold: 80,
			verb: "reached",
			expected: "My Keyboard Right battery reached 80%.",
		},
	])("uses the custom part label for $type notifications", ({
		type,
		prevBatteryInfos,
		newBatteryInfos,
		threshold,
		verb,
		expected,
	}) => {
		const pushNotificationWhen = {
			...notificationTypes,
			[type]: true,
		};

		notifyBatteryEdgeTransitions({
			deviceDisplayName: "My Keyboard",
			deviceId: "keyboard-1",
			prevBatteryInfos,
			newBatteryInfos,
			batteryPartLabels: { Peripheral: "Right" },
			lowBatteryThreshold: verb === "dropped below" ? threshold : 20,
			highBatteryThreshold: verb === "reached" ? threshold : 80,
			pushNotification: true,
			pushNotificationWhen,
		});

		expect(mockSendNotification).toHaveBeenCalledWith(expected);
	});

	it("includes a custom part label for a single battery notification", () => {
		notifyBatteryEdgeTransitions({
			deviceDisplayName: "My Keyboard",
			deviceId: "keyboard-1",
			prevBatteryInfos: [{ battery_level: 50, user_description: null }],
			newBatteryInfos: [{ battery_level: 20, user_description: null }],
			batteryPartLabels: { Central: "Left" },
			lowBatteryThreshold: 20,
			highBatteryThreshold: 80,
			pushNotification: true,
			pushNotificationWhen: {
				...notificationTypes,
				[NotificationType.LowBattery]: true,
			},
		});

		expect(mockSendNotification).toHaveBeenCalledWith("My Keyboard Left battery dropped below 20%.");
	});

	it("keeps the existing single battery notification format without a custom label", () => {
		notifyBatteryEdgeTransitions({
			deviceDisplayName: "My Keyboard",
			deviceId: "keyboard-1",
			prevBatteryInfos: [{ battery_level: 50, user_description: null }],
			newBatteryInfos: [{ battery_level: 20, user_description: null }],
			lowBatteryThreshold: 20,
			highBatteryThreshold: 80,
			pushNotification: true,
			pushNotificationWhen: {
				...notificationTypes,
				[NotificationType.LowBattery]: true,
			},
		});

		expect(mockSendNotification).toHaveBeenCalledWith("My Keyboard battery dropped below 20%.");
	});

	it("does not notify when the battery reaches 0% by default", () => {
		notifyBatteryEdgeTransitions({
			deviceDisplayName: "My Keyboard",
			deviceId: "keyboard-1",
			prevBatteryInfos: [{ battery_level: 50, user_description: null }],
			newBatteryInfos: [{ battery_level: 0, user_description: null }],
			lowBatteryThreshold: 20,
			highBatteryThreshold: 80,
			pushNotification: true,
			pushNotificationWhen: {
				...notificationTypes,
				[NotificationType.LowBattery]: true,
			},
		});

		expect(mockSendNotification).not.toHaveBeenCalled();
	});

	it("notifies when the battery reaches 0% if it is not ignored", () => {
		notifyBatteryEdgeTransitions({
			deviceDisplayName: "My Keyboard",
			deviceId: "keyboard-1",
			prevBatteryInfos: [{ battery_level: 50, user_description: null }],
			newBatteryInfos: [{ battery_level: 0, user_description: null }],
			lowBatteryThreshold: 20,
			highBatteryThreshold: 80,
			pushNotification: true,
			pushNotificationWhen: {
				...notificationTypes,
				[NotificationType.LowBattery]: true,
			},
			ignoreZeroPercent: false,
		});

		expect(mockSendNotification).toHaveBeenCalledWith("My Keyboard battery dropped below 20%.");
	});

	it("notifies when a non-zero low battery level follows an ignored 0% reading", () => {
		notifyBatteryEdgeTransitions({
			deviceDisplayName: "My Keyboard",
			deviceId: "keyboard-1",
			prevBatteryInfos: [{ battery_level: 0, user_description: null }],
			newBatteryInfos: [{ battery_level: 15, user_description: null }],
			lowBatteryThreshold: 20,
			highBatteryThreshold: 80,
			pushNotification: true,
			pushNotificationWhen: {
				...notificationTypes,
				[NotificationType.LowBattery]: true,
			},
		});

		expect(mockSendNotification).toHaveBeenCalledWith("My Keyboard battery dropped below 20%.");
	});
});
