import {
	isPermissionGranted,
	requestPermission,
	sendNotification as sendNotification_,
	type Options as NotificationOptions,
} from '@tauri-apps/plugin-notification';

/*
	* Requests notification permission.
	* @returns true if the notification permission is granted, false otherwise
*/
export async function requestNotificationPermission(): Promise<boolean> {
	const isGranted = await isPermissionGranted();
	if (isGranted) {
		return true;
	} else {
		const permission = await requestPermission();
		return permission === 'granted';
	}
}

/*
	* Sends a notification. Checks if the notification permission is granted before sending.
	* @param title - The title of the notification
	* @param message - The message of the notification
	* @returns true if the notification was sent successfully, false otherwise
*/
export async function sendNotification(title: string, message?: string): Promise<boolean> {
	const isGranted = await requestNotificationPermission();
	if (!isGranted) {
		return false;
	}

	const options: NotificationOptions = {
		title,
		body: message,
		channelId: 'default',
	};
	sendNotification_(options);
	return true;
}
