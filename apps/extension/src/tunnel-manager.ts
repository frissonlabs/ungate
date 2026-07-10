import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bin, install, use, Tunnel } from 'cloudflared';

import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { findCloudflaredPidsForPort, isProcessAlive, killProcess } from './utils/cloudflared-process';

import type { LogEntry, TunnelState } from '@ungate/shared/frontend';

const CLOUDFLARED_BIN_DIR = path.join(os.homedir(), '.ungate', 'bin');

function getCloudflaredBinPath(): string {
	return path.join(CLOUDFLARED_BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

function getCloudflaredLegacyBinPath(): string {
	return path.join(CLOUDFLARED_BIN_DIR, 'cloudflared');
}

function getCloudflaredConfigArg(): string {
	return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

export interface TunnelManagerCallbacks {
	isExtensionHostActive(): boolean;
	onStateChange(state: TunnelState): void;
	onLog(entry: LogEntry): void;
	isLocalApiHealthy(): Promise<boolean>;
	onNeedsApiRecovery(): void;
	onTunnelUrl(url: string, previousUrl: string | null): void;
}

export class TunnelManager {
	private tunnel: Tunnel | null = null;
	private state: TunnelState = { status: 'stopped', url: null, error: null };
	private readonly windowId: string;
	private autoStopTimer: NodeJS.Timeout | null = null;
	private remoteHealthTimer: NodeJS.Timeout | null = null;
	private currentPort: number | null = null;
	private consecutiveRemoteFailures = 0;
	private remoteHealthCheckInFlight = false;
	private refreshInProgress = false;

	constructor(
		windowId: string,
		private readonly callbacks: TunnelManagerCallbacks
	) {
		this.windowId = windowId;
	}

	getState(): TunnelState {
		return { ...this.state };
	}

	getPort(): number | null {
		return this.currentPort;
	}

	async start(port: number): Promise<void> {
		if (this.state.status === 'running') {
			return;
		}

		this.currentPort = port;
		this.killStaleCloudflared(port);

		if (this.tunnel) {
			this.tunnel.stop();
			this.tunnel = null;
		}

		this.setState({ status: 'starting', url: null, error: null }, null);

		await this.ensureBinary();

		if (this.state.status === 'error') {
			return;
		}

		this.spawnTunnel(port);
		this.scheduleAutoStop();
	}

	stop(): void {
		this.stopRemoteHealthCheck();
		this.consecutiveRemoteFailures = 0;

		if (this.autoStopTimer) {
			clearInterval(this.autoStopTimer);
			this.autoStopTimer = null;
		}

		if (this.tunnel) {
			this.tunnel.stop();
			this.tunnel = null;
		}

		if (this.currentPort) {
			this.killStaleCloudflared(this.currentPort);
		}

		this.setState({ status: 'stopped', url: null, error: null }, null);
	}

	async restart(port: number): Promise<void> {
		if (this.refreshInProgress) {
			return;
		}

		this.refreshInProgress = true;

		try {
			this.stop();
			await this.start(port);
		} finally {
			this.refreshInProgress = false;
		}
	}

	killStaleCloudflared(port: number): void {
		const keepPid = this.tunnel?.process?.pid ?? null;
		const runtimePid = RuntimeStateStore.read().tunnel.pid;
		const candidates = new Set<number>();

		if (runtimePid && runtimePid !== keepPid) {
			candidates.add(runtimePid);
		}

		for (const pid of findCloudflaredPidsForPort(port)) {
			if (pid !== keepPid) {
				candidates.add(pid);
			}
		}

		for (const pid of candidates) {
			if (!isProcessAlive(pid)) {
				continue;
			}

			if (killProcess(pid, 'SIGINT')) {
				this.callbacks.onLog({
					timestamp: Date.now(),
					level: 'info',
					message: `Killed stale cloudflared pid=${pid} for port ${port}`
				});
			}
		}
	}

	private async ensureBinary(): Promise<void> {
		const devBinExists = fs.existsSync(bin);
		const userBinPath = this.resolveUserBinaryPath();

		if (devBinExists) {
			return;
		}

		if (userBinPath) {
			use(userBinPath);

			return;
		}

		this.setState({ status: 'installing', url: null, error: null }, null);
		this.callbacks.onLog({ timestamp: Date.now(), level: 'info', message: 'Downloading cloudflared binary...' });

		try {
			fs.mkdirSync(CLOUDFLARED_BIN_DIR, { recursive: true });
			const installPath = getCloudflaredBinPath();
			const installedPath = await install(installPath);

			use(installedPath);
			this.callbacks.onLog({ timestamp: Date.now(), level: 'info', message: 'cloudflared installed successfully' });
			this.setState({ status: 'starting', url: null, error: null }, null);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.callbacks.onLog({
				timestamp: Date.now(),
				level: 'error',
				message: `Failed to install cloudflared: ${message}`
			});
			this.setState({ status: 'error', url: null, error: `Install failed: ${message}` }, null);
		}
	}

	private resolveUserBinaryPath(): string | null {
		const binPath = getCloudflaredBinPath();

		if (fs.existsSync(binPath)) {
			return binPath;
		}

		const legacyPath = getCloudflaredLegacyBinPath();

		if (process.platform === 'win32' && fs.existsSync(legacyPath)) {
			fs.renameSync(legacyPath, binPath);

			return binPath;
		}

		return null;
	}

	private spawnTunnel(port: number): void {
		const t = Tunnel.quick(`http://localhost:${port}`, {
			'--config': getCloudflaredConfigArg(),
			'--edge-ip-version': '4'
		});
		this.tunnel = t;

		t.on('url', (url) => {
			const previousUrl = this.state.url;
			const pid = t.process?.pid ?? null;

			this.callbacks.onLog({ timestamp: Date.now(), level: 'info', message: `Tunnel URL: ${url}` });
			this.setState({ status: 'running', url, error: null }, pid);
			this.consecutiveRemoteFailures = 0;
			this.scheduleAutoStop();
			this.startRemoteHealthCheck();
			this.callbacks.onTunnelUrl(url, previousUrl);
		});

		t.on('stderr', (data) => {
			const lines = data.split('\n').filter((l) => l.trim());

			for (const line of lines) {
				this.callbacks.onLog({ timestamp: Date.now(), level: 'info', message: line });
			}
		});

		t.on('error', (err) => {
			const message = err.message;
			this.callbacks.onLog({ timestamp: Date.now(), level: 'error', message: `Tunnel error: ${message}` });
			this.stopRemoteHealthCheck();
			this.setState({ status: 'error', url: null, error: message }, null);
		});

		t.on('exit', (code, signal) => {
			this.callbacks.onLog({
				timestamp: Date.now(),
				level: 'warn',
				message: `Tunnel exited code=${code} signal=${signal}`
			});

			const wasStarting = this.state.status === 'starting';

			this.stopRemoteHealthCheck();

			if (this.state.status !== 'stopped') {
				const next: TunnelState = wasStarting
					? { status: 'error', url: null, error: `Process exited before tunnel was ready (code=${code})` }
					: { status: 'stopped', url: null, error: null };

				this.setState(next, null);
			}

			this.tunnel = null;
		});
	}

	private setState(next: TunnelState, pid: number | null): void {
		this.state = next;
		void this.persistTunnelState(next, pid).catch(() => {});
	}

	private async persistTunnelState(next: TunnelState, pid: number | null): Promise<void> {
		await RuntimeStateStore.mutate((current) => {
			current.tunnel.status = next.status;
			current.tunnel.url = next.url;
			current.tunnel.pid = next.status === 'running' || next.status === 'starting' ? pid : null;
			current.tunnel.lastSeenAt = Date.now();
			current.tunnel.lastError = next.error;
			current.tunnel.ownerWindowId = this.windowId;

			return current;
		});
		this.callbacks.onStateChange(next);
	}

	private scheduleAutoStop(): void {
		if (this.autoStopTimer) {
			return;
		}

		this.autoStopTimer = setInterval(() => {
			const runtimeState = RuntimeStateStore.read();
			const hasLiveClientsOnDisk = RuntimeStateStore.hasLiveClients(runtimeState);

			if (!hasLiveClientsOnDisk && !this.callbacks.isExtensionHostActive()) {
				this.stop();
			}
		}, config.tunnelManager.autoStopCheckIntervalMs);
	}

	private startRemoteHealthCheck(): void {
		this.stopRemoteHealthCheck();

		this.remoteHealthTimer = setInterval(() => {
			void this.runRemoteHealthCheck().catch(() => {});
		}, config.tunnelManager.remoteHealthCheckIntervalMs);
	}

	private stopRemoteHealthCheck(): void {
		if (this.remoteHealthTimer) {
			clearInterval(this.remoteHealthTimer);
			this.remoteHealthTimer = null;
		}
	}

	private async runRemoteHealthCheck(): Promise<void> {
		if (this.remoteHealthCheckInFlight || this.refreshInProgress) {
			return;
		}

		if (this.state.status !== 'running' || !this.state.url || !this.currentPort) {
			return;
		}

		this.remoteHealthCheckInFlight = true;

		try {
			const healthy = await this.checkRemoteHealth(this.state.url);

			if (healthy) {
				this.consecutiveRemoteFailures = 0;

				return;
			}

			this.consecutiveRemoteFailures += 1;
			this.callbacks.onLog({
				timestamp: Date.now(),
				level: 'warn',
				message: `Remote tunnel health failed (${this.consecutiveRemoteFailures}/${config.tunnelManager.remoteHealthFailureThreshold})`
			});

			if (this.consecutiveRemoteFailures < config.tunnelManager.remoteHealthFailureThreshold) {
				return;
			}

			this.consecutiveRemoteFailures = 0;
			const apiHealthy = await this.callbacks.isLocalApiHealthy();

			if (apiHealthy) {
				this.callbacks.onLog({
					timestamp: Date.now(),
					level: 'info',
					message: 'Refreshing stale tunnel after remote health failures'
				});
				await this.restart(this.currentPort);

				return;
			}

			this.callbacks.onLog({
				timestamp: Date.now(),
				level: 'warn',
				message: 'Remote tunnel unhealthy and local API down; requesting API recovery'
			});
			this.callbacks.onNeedsApiRecovery();
		} finally {
			this.remoteHealthCheckInFlight = false;
		}
	}

	private async checkRemoteHealth(url: string): Promise<boolean> {
		try {
			const response = await fetch(`${url}/health`, {
				signal: AbortSignal.timeout(config.tunnelManager.remoteHealthRequestTimeoutMs)
			});

			return response.ok;
		} catch {
			return false;
		}
	}
}
