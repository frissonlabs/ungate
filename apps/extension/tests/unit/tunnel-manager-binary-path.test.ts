import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		existsSyncMock: vi.fn(),
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
			read: vi.fn(() => ({ clients: {}, tunnel: { pid: 4242 } })),
			hasLiveClients: vi.fn(() => true)
		}
	};
});

import { TunnelManager } from '../../src/tunnel-manager';

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

describe('TunnelManager cloudflared binary path', () => {
	const binDir = path.join(os.homedir(), '.ungate', 'bin');

	beforeEach(() => {
		mocks.tunnelQuickMock.mockReset();
		mocks.tunnelQuickMock.mockReturnValue({
			on: vi.fn(),
			stop: vi.fn(),
			process: { pid: 111 }
		});
		mocks.findCloudflaredPidsForPortMock.mockReturnValue([]);
		mocks.isProcessAliveMock.mockReturnValue(false);
		mocks.killProcessMock.mockReturnValue(false);
		mocks.existsSyncMock.mockReset();
		mocks.renameSyncMock.mockReset();
		mocks.installMock.mockReset();
		mocks.useMock.mockReset();
		mocks.runtimeMutateMock.mockClear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('installs cloudflared.exe on win32', async () => {
		const originalPlatform = process.platform;

		Object.defineProperty(process, 'platform', { value: 'win32' });

		const expectedPath = path.join(binDir, 'cloudflared.exe');

		mocks.existsSyncMock.mockReturnValue(false);
		mocks.installMock.mockResolvedValue(expectedPath);

		const manager = new TunnelManager('window-a', createCallbacks());

		await manager.start(47821);

		Object.defineProperty(process, 'platform', { value: originalPlatform });

		expect(mocks.installMock).toHaveBeenCalledWith(expectedPath);
		expect(mocks.useMock).toHaveBeenCalledWith(expectedPath);
	});

	it('renames a legacy Windows install without .exe extension', async () => {
		const originalPlatform = process.platform;

		Object.defineProperty(process, 'platform', { value: 'win32' });

		const legacyPath = path.join(binDir, 'cloudflared');
		const expectedPath = path.join(binDir, 'cloudflared.exe');

		mocks.existsSyncMock.mockImplementation((target) => {
			const value = String(target);

			return value === legacyPath;
		});

		const manager = new TunnelManager('window-a', createCallbacks());

		await manager.start(47821);

		Object.defineProperty(process, 'platform', { value: originalPlatform });

		expect(mocks.renameSyncMock).toHaveBeenCalledWith(legacyPath, expectedPath);
		expect(mocks.useMock).toHaveBeenCalledWith(expectedPath);
		expect(mocks.installMock).not.toHaveBeenCalled();
	});

	it('kills stale cloudflared pids before starting', async () => {
		mocks.existsSyncMock.mockReturnValue(true);
		mocks.findCloudflaredPidsForPortMock.mockReturnValue([9001, 9002]);
		mocks.isProcessAliveMock.mockReturnValue(true);
		mocks.killProcessMock.mockReturnValue(true);

		const callbacks = createCallbacks();
		const manager = new TunnelManager('window-a', callbacks);

		await manager.start(47821);

		expect(mocks.findCloudflaredPidsForPortMock).toHaveBeenCalledWith(47821);
		expect(mocks.killProcessMock).toHaveBeenCalledWith(4242, 'SIGINT');
		expect(mocks.killProcessMock).toHaveBeenCalledWith(9001, 'SIGINT');
		expect(mocks.killProcessMock).toHaveBeenCalledWith(9002, 'SIGINT');
		expect(callbacks.onLog).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('Killed stale cloudflared pid=') })
		);
	});

	it('persists tunnel pid when url is ready', async () => {
		mocks.existsSyncMock.mockReturnValue(true);

		const handlers = new Map<string, (value?: unknown) => void>();
		mocks.tunnelQuickMock.mockReturnValue({
			on(event: string, handler: (value?: unknown) => void) {
				handlers.set(event, handler);
			},
			stop: vi.fn(),
			process: { pid: 5555 }
		});

		const callbacks = createCallbacks();
		const manager = new TunnelManager('window-a', callbacks);

		await manager.start(47821);
		handlers.get('url')?.('https://example.trycloudflare.com');

		expect(mocks.runtimeMutateMock).toHaveBeenCalled();
		expect(callbacks.onTunnelUrl).toHaveBeenCalledWith('https://example.trycloudflare.com', null);
		expect(manager.getState()).toEqual({
			status: 'running',
			url: 'https://example.trycloudflare.com',
			error: null
		});
	});
});
