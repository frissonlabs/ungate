import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		existsSyncMock: vi.fn(() => true),
		renameSyncMock: vi.fn(),
		installMock: vi.fn(),
		useMock: vi.fn(),
		binExport: '/dev/cloudflared-package/bin/cloudflared',
		findCloudflaredPidsForPortMock: vi.fn(() => [] as number[]),
		isProcessAliveMock: vi.fn(() => false),
		killProcessMock: vi.fn(() => false),
		tunnelQuickMock: vi.fn(),
		runtimeMutateMock: vi.fn((mutator: (state: { tunnel: Record<string, unknown> }) => unknown) =>
			Promise.resolve(mutator({ tunnel: { pid: null } }))
		)
	};
});

vi.mock('cloudflared', () => {
	return {
		bin: mocks.binExport,
		install: mocks.installMock,
		use: mocks.useMock,
		Tunnel: {
			quick: (...args: unknown[]) => mocks.tunnelQuickMock(...args)
		}
	};
});

vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();

	return {
		...original,
		existsSync: mocks.existsSyncMock,
		renameSync: mocks.renameSyncMock
	};
});

vi.mock('../../src/utils/cloudflared-process', () => {
	return {
		findCloudflaredPidsForPort: mocks.findCloudflaredPidsForPortMock,
		isProcessAlive: mocks.isProcessAliveMock,
		killProcess: mocks.killProcessMock
	};
});

vi.mock('../../src/runtime-state', () => {
	return {
		RuntimeStateStore: {
			mutate: mocks.runtimeMutateMock,
			read: vi.fn(() => ({ clients: {}, tunnel: { pid: null } })),
			hasLiveClients: vi.fn(() => true)
		}
	};
});

import { TunnelManager } from '../../src/tunnel-manager';

interface TunnelStub {
	handlers: Map<string, (...args: unknown[]) => void>;
	stop: ReturnType<typeof vi.fn>;
}

function createCallbacks() {
	return {
		isExtensionHostActive: () => true,
		onStateChange: vi.fn(),
		onLog: vi.fn(),
		isLocalApiHealthy: vi.fn(() => Promise.resolve(true)),
		onNeedsApiRecovery: vi.fn(),
		onTunnelUrl: vi.fn()
	};
}

describe('TunnelManager auto-restart on unexpected exit', () => {
	const PORT = 47821;
	let stubs: TunnelStub[];

	beforeEach(() => {
		vi.useFakeTimers();
		stubs = [];
		mocks.existsSyncMock.mockReturnValue(true);
		mocks.findCloudflaredPidsForPortMock.mockReturnValue([]);
		mocks.isProcessAliveMock.mockReturnValue(false);
		mocks.killProcessMock.mockReturnValue(false);
		mocks.runtimeMutateMock.mockClear();
		mocks.tunnelQuickMock.mockReset();
		mocks.tunnelQuickMock.mockImplementation(() => {
			const handlers = new Map<string, (...args: unknown[]) => void>();
			const stop = vi.fn();
			stubs.push({ handlers, stop });

			return {
				on(event: string, handler: (...args: unknown[]) => void) {
					handlers.set(event, handler);
				},
				stop,
				process: { pid: 1000 + stubs.length }
			};
		});
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	function emit(stubIndex: number, event: string, ...args: unknown[]): void {
		stubs[stubIndex].handlers.get(event)?.(...args);
	}

	it('respawns the tunnel after an unexpected process exit', async () => {
		const callbacks = createCallbacks();
		const manager = new TunnelManager('window-a', callbacks);

		await manager.start(PORT);
		emit(0, 'url', 'https://a.trycloudflare.com');
		expect(mocks.tunnelQuickMock).toHaveBeenCalledTimes(1);

		emit(0, 'exit', 1, null);

		// The base backoff delay is 1000ms; a new tunnel should be spawned after it.
		await vi.advanceTimersByTimeAsync(1000);

		expect(mocks.tunnelQuickMock).toHaveBeenCalledTimes(2);

		emit(1, 'url', 'https://b.trycloudflare.com');
		expect(callbacks.onTunnelUrl).toHaveBeenLastCalledWith('https://b.trycloudflare.com', null);
	});

	it('does not respawn after a deliberate stop', async () => {
		const manager = new TunnelManager('window-a', createCallbacks());

		await manager.start(PORT);
		emit(0, 'url', 'https://a.trycloudflare.com');

		manager.stop();
		// A late exit event from the killed process must not trigger a restart.
		emit(0, 'exit', 0, 'SIGINT');

		await vi.advanceTimersByTimeAsync(5000);

		expect(mocks.tunnelQuickMock).toHaveBeenCalledTimes(1);
		expect(manager.getState().status).toBe('stopped');
	});

	it('ignores exit events from a stale tunnel', async () => {
		const manager = new TunnelManager('window-a', createCallbacks());

		await manager.start(PORT);
		emit(0, 'url', 'https://a.trycloudflare.com');

		// Force a fresh tunnel to become current, then fire the old tunnel's exit.
		await manager.restart(PORT);
		expect(mocks.tunnelQuickMock).toHaveBeenCalledTimes(2);

		emit(1, 'url', 'https://b.trycloudflare.com');
		emit(0, 'exit', 1, null);

		await vi.advanceTimersByTimeAsync(5000);

		// The stale exit must not have scheduled another restart.
		expect(mocks.tunnelQuickMock).toHaveBeenCalledTimes(2);
		expect(manager.getState()).toEqual({ status: 'running', url: 'https://b.trycloudflare.com', error: null });
	});

	it('gives up after the maximum number of restart attempts', async () => {
		const callbacks = createCallbacks();
		const manager = new TunnelManager('window-a', callbacks);

		await manager.start(PORT);
		emit(0, 'url', 'https://a.trycloudflare.com');

		// Repeatedly kill each freshly spawned tunnel before it emits a URL.
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const currentStub = stubs.length - 1;
			emit(currentStub, 'exit', 1, null);
			await vi.advanceTimersByTimeAsync(30000);
		}

		// 1 initial + 10 restart attempts = 11 total spawns, then it stops trying.
		expect(mocks.tunnelQuickMock).toHaveBeenCalledTimes(11);
		expect(manager.getState().status).toBe('error');
		expect(callbacks.onLog).toHaveBeenCalledWith(
			expect.objectContaining({ level: 'error', message: expect.stringContaining('giving up') })
		);
	});

	it('surfaces Cloudflare rate limits and does not auto-restart', async () => {
		const callbacks = createCallbacks();
		const manager = new TunnelManager('window-a', callbacks);

		await manager.start(PORT);
		emit(
			0,
			'stderr',
			'ERR Error unmarshaling QuickTunnel response: error code: 1015\n error="x" status_code="429 Too Many Requests"\n'
		);
		emit(0, 'exit', 1, null);

		await vi.advanceTimersByTimeAsync(60000);

		expect(mocks.tunnelQuickMock).toHaveBeenCalledTimes(1);
		expect(manager.getState()).toEqual({
			status: 'error',
			url: null,
			error: expect.stringContaining('rate-limited')
		});
	});
});
