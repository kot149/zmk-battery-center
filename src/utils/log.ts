import { warn, debug, trace, info, error } from '@tauri-apps/plugin-log';

export class Logger {
	warn = warn;
	debug = debug;
	trace = trace;
	info = info;
	error = error;
}

export const logger = new Logger();

function formatConsoleArgs(args: unknown[]): string {
	if (args.length === 0) return '';
	const first = args[0];
	if (typeof first === 'string' && args.length > 1) {
		let i = 1;
		const formatted = first.replace(/%[sdioOcf%]/g, (match) => {
			if (match === '%%') return '%';
			if (i >= args.length) return match;
			return String(args[i++]);
		});
		const rest = args.slice(i).map(String);
		return rest.length > 0 ? `${formatted} ${rest.join(' ')}` : formatted;
	}
	return args.map(String).join(' ');
}

function forwardConsole(
	fnName: 'log' | 'debug' | 'info' | 'warn' | 'error',
	logger: (message: string) => Promise<void>
) {
	const original = console[fnName];
	console[fnName] = (...args: unknown[]) => {
		original(...args);
		logger(formatConsoleArgs(args));
	};
}

forwardConsole('log', trace);
forwardConsole('debug', debug);
forwardConsole('info', info);
forwardConsole('warn', warn);
forwardConsole('error', error);
