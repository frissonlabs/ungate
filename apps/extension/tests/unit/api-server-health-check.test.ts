import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiServer } from '../../src/api-server';

import { TestHelper } from './helpers/test-helper';

import type { RuntimeState } from '@ungate/shared/frontend';

const {
	runtimeReadMock,
	runtimeHasLiveClientsMock,
	runtimeMutateMock,
	sleepMock,
	ensureInstalledMock,
	spawnSyncMock,
	spawnMock,
	isProcessAliveMock,
	killProcessMock
} = vi.hoisted(() => {
	const runtimeReadMock = vi.fn<() => RuntimeState>();
	const runtimeHasLiveClientsMock = vi.fn<(state: RuntimeState) => boolean>();
	const runtimeMutateMock = vi.fn<(mutator: (current: RuntimeState) => RuntimeState) => Promise<RuntimeState>>();
	const sleepMock = vi.fn<(ms: number) => Promise<void>>();
	const ensureInstalledMock = vi.fn<() => Promise<void>>();
	const spawnSyncMock = vi.fn();
	const spawnMock = vi.fn(() => {
		const handlers = new Map<string, ((value?: unknown) => void)[]>();
		const child = {
			stderr: { on: vi.fn() },
			stdout: { on: vi.fn() },
			on(event: string, handler: (value?: unknown) => void) {
				const queue = handlers.get(event) ?? [];
				queue.push(handler);
				handlers.set(event, queue);

				return child;
			},
			unref: vi.fn(),
			kill: vi.fn()
		};

		return child;
	});
	const isProcessAliveMock = vi.fn<(pid: number | null | undefined) => boolean>(() => false);
	const killProcessMock = vi.fn<(pid: number, signal?: NodeJS.Signals) => boolean>(() => true);

	return {
		runtimeReadMock,
		runtimeHasLiveClientsMock,
		runtimeMutateMock,
		sleepMock,
		ensureInstalledMock,
		spawnSyncMock,
		spawnMock,
		isProcessAliveMock,
		killProcessMock
	};
});

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>();

	return {
		...actual,
		spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
		spawn: (...args: unknown[]) => spawnMock(...args)
	};
});

vi.mock('../../src/utils/better-sqlite3-installer', () => {
	return {
		BetterSqlite3Installer: {
			ensureInstalled: (...args: unknown[]) => ensureInstalledMock(...args),
			getInstalledBinaryPath: vi.fn(
				() => '/tmp/ungate-extension/bundled/api/node_modules/better-sqlite3/build/Release/better_sqlite3.installed.node'
			)
		}
	};
});

vi.mock('../../src/utils/cloudflared-process', () => {
	return {
		isProcessAlive: isProcessAliveMock,
		killProcess: killProcessMock,
		findCloudflaredPidsForPort: vi.fn(() => [])
	};
});

vi.mock('@ungate/shared', () => {
	return {
		sleep: sleepMock
	};
});

vi.mock('vscode', () => {
	return {
		ExtensionMode: {
			Development: 1,
			Production: 2
		}
	};
});

const isApiStartSuppressedMock = vi.fn<() => boolean>(() => false);
const suppressApiAutoStartMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
const resetApiForRestartMock = vi.fn<() => Promise<void>>(() => Promise.resolve());

vi.mock('../../src/runtime-state', () => {
	return {
		RuntimeStateStore: {
			read: runtimeReadMock,
			hasLiveClients: runtimeHasLiveClientsMock,
			mutate: runtimeMutateMock,
			isApiStartSuppressed: (...args: unknown[]) => isApiStartSuppressedMock(...args),
			suppressApiAutoStart: (...args: unknown[]) => suppressApiAutoStartMock(...args),
			resetApiForRestart: (...args: unknown[]) => resetApiForRestartMock(...args)
		}
	};
});

interface ApiServerInternals {
	port: number | null;
	process: { kill: ReturnType<typeof vi.fn>; pid?: number } | null;
	lastStatus: 'starting' | 'running' | 'stopped' | 'error' | null;
	restartRequested: boolean;
	restartInProgress: boolean;
	shutDownDeliberately: boolean;
	startPromise: Promise<void> | null;
	addressInUsePort: number | null;
	consecutiveHealthFailures: number;
	lastHungRestartAt: number;
	hungRestartInProgress: boolean;
	runHealthCheckCycle(): Promise<void>;
	onExit(code: number | null, signal: NodeJS.Signals | null): void;
	onStderr(data: Buffer): void;
	spawn(): void;
	ensureNativeDeps(): Promise<void>;
	checkPortHealth(port: number): Promise<boolean>;
	startHealthCheck(): void;
	shouldRespawn(): boolean;
}

function createRuntimeState(): RuntimeState {
	const runtimeState = TestHelper.createRuntimeState([], 4783);

	return runtimeState;
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function getInternals(server: InstanceType<typeof ApiServer>): ApiServerInternals {
	return server as unknown as ApiServerInternals;
}

function createServer(options?: { isLeaderWindow?: boolean; isExtensionHostActive?: boolean }): {
	server: InstanceType<typeof ApiServer>;
	onStatusChange: ReturnType<typeof vi.fn>;
	onPortDetected: ReturnType<typeof vi.fn>;
	onLog: ReturnType<typeof vi.fn>;
} {
	const onStatusChange = vi.fn();
	const onPortDetected = vi.fn();
	const onLog = vi.fn();
	const server = new ApiServer(
		{
			extensionMode: 1,
			extensionPath: '/tmp/ungate-extension'
		} as never,
		{
			onLog,
			onPortDetected,
			onStatusChange,
			isLeaderWindow() {
				return options?.isLeaderWindow ?? true;
			},
			isExtensionHostActive() {
				return options?.isExtensionHostActive ?? true;
			},
			getWindowId() {
				return 'test-window';
			}
		}
	);

	return { server, onStatusChange, onPortDetected, onLog };
}

describe('ApiServer.runHealthCheckCycle', () => {
	beforeEach(() => {
		runtimeReadMock.mockReset();
		runtimeHasLiveClientsMock.mockReset();
		runtimeMutateMock.mockReset();
		isApiStartSuppressedMock.mockReset();
		isApiStartSuppressedMock.mockReturnValue(false);
		suppressApiAutoStartMock.mockReset();
		resetApiForRestartMock.mockReset();
		sleepMock.mockReset();
		ensureInstalledMock.mockReset();
		spawnSyncMock.mockReset();
		spawnSyncMock.mockImplementation((runtime, args) => {
			if (Array.isArray(args) && args[0] === '-p' && typeof args[1] === 'string' && args[1].includes('process.execPath')) {
				return {
					error: undefined,
					status: 0,
					stdout: '/usr/local/bin/node',
					stderr: '',
					pid: 1,
					output: [null, '/usr/local/bin/node', ''],
					signal: null
				};
			}

			return {
				error: undefined,
				status: 0,
				stdout: 'v24.0.0\n',
				stderr: '',
				pid: 1,
				output: [null, 'v24.0.0\n', ''],
				signal: null
			};
		});
		ensureInstalledMock.mockResolvedValue(undefined);
		vi.unstubAllGlobals();
		vi.useRealTimers();
		isProcessAliveMock.mockReset();
		isProcessAliveMock.mockReturnValue(false);
		killProcessMock.mockReset();
		killProcessMock.mockReturnValue(true);
	});

	it('does not mark attached running api as stopped after a transient health-check failure', async () => {
		const runtimeState = createRuntimeState();
		const { server, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.reject(new Error('temporary network failure'));
			})
		);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		await internals.runHealthCheckCycle();

		expect(onStatusChange).not.toHaveBeenCalledWith('stopped');
	});

	it('attaches to an existing healthy api without spawning a new process', async () => {
		const runtimeState = createRuntimeState();
		const { server, onPortDetected, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});

		await server.start();

		expect(spawnSpy).not.toHaveBeenCalled();
		expect(onPortDetected).toHaveBeenCalledWith(4783);
		expect(onStatusChange).toHaveBeenCalledWith('running');
	});

	it('does not spawn a second process when start is called again during local startup', async () => {
		const runtimeState = createRuntimeState();
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		Object.assign(internals, {
			process: {}
		});

		await server.start();

		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it('passes the installed better-sqlite3 binary path to the api process', async () => {
		const runtimeState = createRuntimeState([], null);
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});

		vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});

		await server.start();

		expect(spawnMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					UNGATE_BETTER_SQLITE3_NATIVE_BINDING: expect.stringContaining('better_sqlite3.installed.node')
				})
			})
		);
	});

	it('retries startup when shared starting state is stale', async () => {
		const runtimeState = createRuntimeState([], null);
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeState.api.status = 'starting';
		runtimeState.api.ownerWindowId = 'other-window';
		runtimeState.api.lastSeenAt = Date.now() - 15000;
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		await server.start();

		expect(ensureInstalledMock).toHaveBeenCalledTimes(1);
		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it('deduplicates parallel start calls while native deps are pending', async () => {
		const runtimeState = createRuntimeState([], null);
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});

		let releaseNative: (() => void) | undefined;
		ensureInstalledMock.mockImplementation(() => {
			return new Promise<void>((resolve) => {
				releaseNative = resolve;
			});
		});

		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		const first = server.start();
		const second = server.start();

		expect(server.isStartupInProgress()).toBe(true);

		await vi.waitFor(() => {
			expect(ensureInstalledMock).toHaveBeenCalledTimes(1);
		});
		expect(spawnSpy).not.toHaveBeenCalled();

		releaseNative?.();
		await Promise.all([first, second]);

		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it('does not retry start automatically after native dependency installation fails', async () => {
		const runtimeState = createRuntimeState([], null);
		const { server } = createServer();
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		ensureInstalledMock.mockRejectedValue(new Error('[native] better-sqlite3 prebuilt installation failed'));

		await expect(server.start()).rejects.toThrow('[native] better-sqlite3 prebuilt installation failed');
		expect(suppressApiAutoStartMock).toHaveBeenCalled();
		ensureInstalledMock.mockClear();
		isApiStartSuppressedMock.mockReturnValue(true);

		await server.start();

		expect(ensureInstalledMock).not.toHaveBeenCalled();
	});

	it('does not stop api before the no-clients grace period elapses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const runtimeState = createRuntimeState();
		const { server } = createServer({ isExtensionHostActive: false });
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({ ok: true });
			})
		);
		const stopSpy = vi.spyOn(server, 'stop').mockResolvedValue(undefined);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		await internals.runHealthCheckCycle();
		vi.setSystemTime(2500);
		await internals.runHealthCheckCycle();

		expect(stopSpy).not.toHaveBeenCalled();
	});

	it('stops api after the no-clients grace period elapses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const runtimeState = createRuntimeState();
		const { server } = createServer({ isExtensionHostActive: false });
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({ ok: true });
			})
		);
		const stopSpy = vi.spyOn(server, 'stop').mockResolvedValue(undefined);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		await internals.runHealthCheckCycle();
		vi.setSystemTime(3001);
		await internals.runHealthCheckCycle();

		expect(stopSpy).toHaveBeenCalledTimes(1);
	});

	it('does not stop api when extension host is still active', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const runtimeState = createRuntimeState();
		const { server } = createServer({ isExtensionHostActive: true });
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({ ok: true });
			})
		);
		const stopSpy = vi.spyOn(server, 'stop').mockResolvedValue(undefined);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		vi.setSystemTime(5000);
		await internals.runHealthCheckCycle();

		expect(stopSpy).not.toHaveBeenCalled();
	});
});

describe('ApiServer.onExit', () => {
	beforeEach(() => {
		sleepMock.mockReset();
		sleepMock.mockResolvedValue(undefined);
		ensureInstalledMock.mockReset();
		ensureInstalledMock.mockResolvedValue(undefined);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(createRuntimeState());

			return Promise.resolve(nextState);
		});
	});

	it('starts again after a requested restart exit', async () => {
		const { server } = createServer();
		const internals = getInternals(server);
		const startSpy = vi.spyOn(server, 'start').mockResolvedValue(undefined);

		Object.assign(internals, {
			restartRequested: true,
			restartInProgress: true,
			process: null
		});

		internals.onExit(null, 'SIGTERM');
		await flushPromises();

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(sleepMock).toHaveBeenCalledTimes(1);
		expect(internals.restartRequested).toBe(false);
		expect(internals.restartInProgress).toBe(false);
	});

	it('does not respawn after a deliberate shutdown', () => {
		const { server } = createServer();
		const internals = getInternals(server);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		Object.assign(internals, {
			shutDownDeliberately: true,
			process: null
		});

		internals.onExit(0, null);

		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it('respawns after a clean exit', async () => {
		const { server } = createServer();
		const internals = getInternals(server);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		Object.assign(internals, {
			restartRequested: false,
			shutDownDeliberately: false,
			process: null
		});

		internals.onExit(0, null);
		await flushPromises();

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(sleepMock).toHaveBeenCalledTimes(1);
	});

	it('marks status as error after a non-zero exit', async () => {
		const runtimeState = createRuntimeState();
		const { server, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});

		Object.assign(internals, {
			restartRequested: false,
			shutDownDeliberately: false,
			process: null
		});

		internals.onExit(1, null);
		await flushPromises();

		expect(onStatusChange).toHaveBeenCalledWith('error');
	});

	it('does not respawn after a clean exit when extension host is inactive', async () => {
		const { server } = createServer({ isExtensionHostActive: false });
		const internals = getInternals(server);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		Object.assign(internals, {
			restartRequested: false,
			shutDownDeliberately: false,
			process: null
		});

		internals.onExit(0, null);
		await flushPromises();

		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it('attaches to an already running api after EADDRINUSE instead of staying in error', async () => {
		const runtimeState = createRuntimeState();
		const { server, onPortDetected, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});

		Object.assign(internals, {
			addressInUsePort: 47821,
			process: null,
			restartRequested: false,
			shutDownDeliberately: false
		});

		internals.onExit(1, null);
		await flushPromises();

		expect(onPortDetected).toHaveBeenCalledWith(47821);
		expect(onStatusChange).toHaveBeenCalledWith('running');
		expect(onStatusChange).not.toHaveBeenCalledWith('error');
	});

	it('detects the port from the first EADDRINUSE stderr chunk before the serialized error object arrives', async () => {
		const { server, onPortDetected, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(createRuntimeState()));

			return Promise.resolve(nextState);
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});

		Object.assign(internals, {
			addressInUsePort: null,
			process: null,
			restartRequested: false,
			shutDownDeliberately: false
		});

		internals.onStderr(Buffer.from('Error: listen EADDRINUSE: address already in use 0.0.0.0:47821\n'));
		expect(internals.addressInUsePort).toBe(47821);

		internals.onExit(1, null);
		await flushPromises();

		expect(onPortDetected).toHaveBeenCalledWith(47821);
		expect(onStatusChange).toHaveBeenCalledWith('running');
		expect(onStatusChange).not.toHaveBeenCalledWith('error');
	});

	it('kills a hung api process and restarts after repeated health failures', async () => {
		const runtimeState = createRuntimeState();
		const { server, onStatusChange, onLog } = createServer();
		const internals = getInternals(server);
		const child = { pid: 4242, kill: vi.fn() };

		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(true);
		runtimeMutateMock.mockImplementation((mutator) => Promise.resolve(mutator(structuredClone(runtimeState))));
		isProcessAliveMock.mockReturnValue(true);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.reject(new Error('connection refused')))
		);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: child,
			consecutiveHealthFailures: 0,
			lastHungRestartAt: 0,
			hungRestartInProgress: false
		});

		await internals.runHealthCheckCycle();
		expect(child.kill).not.toHaveBeenCalled();
		expect(onStatusChange).toHaveBeenCalledWith('error');

		await internals.runHealthCheckCycle();

		expect(resetApiForRestartMock).toHaveBeenCalled();
		expect(child.kill).toHaveBeenCalled();
		expect(internals.restartRequested).toBe(true);
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('recovering hung api'));
	});
});
