import * as path from 'node:path';

import {
	DEFAULT_KEY_FIX_ENABLED,
	sleep,
	type ApiStatus as ApiLifecycleStatus,
	type LogEntry,
	type RuntimeCommandAction,
	type RuntimeState,
	type TunnelState
} from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { ApiServer } from './api-server';
import { Dashboard, type Msg } from './dashboard';
import { extensionCommands } from './extension-commands';
import { ExtensionStatusBar } from './extension-status-bar';
import { OpenAiKeyFix } from './openai-key-fix';
import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { TunnelManager } from './tunnel-manager';
import { CursorOpenAiBaseUrlWriter } from './utils/cursor-openai-base-url';

export class ExtensionController {
	private outputChannel!: vscode.OutputChannel;
	private statusBar!: vscode.StatusBarItem;
	private dashboard!: Dashboard;
	private tunnelManager!: TunnelManager;
	private apiServer!: ApiServer;
	private keyFix!: OpenAiKeyFix;
	private baseUrlWriter!: CursorOpenAiBaseUrlWriter;
	private currentPort: number | null = null;
	private lastApiStatus: ApiLifecycleStatus | null = null;
	private currentTunnelState: TunnelState = { status: 'stopped', url: null, error: null };
	private tunnelDesired = false;
	private recoveryInProgress = false;
	private readonly windowId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private syncTimer: NodeJS.Timeout | null = null;
	private runtimeStateWatcher: vscode.FileSystemWatcher | null = null;
	private runtimeStateSyncDebounce: NodeJS.Timeout | null = null;
	private lastCommandId: string | null = null;
	private extensionHostActive = false;
	private baseUrlReconcileTimer: NodeJS.Timeout | null = null;
	private baseUrlReconcileInFlight = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	public activate(): void {
		this.extensionHostActive = true;
		this.outputChannel = vscode.window.createOutputChannel('Ungate');
		this.context.subscriptions.push(this.outputChannel);

		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.statusBar.command = extensionCommands.openDashboard;
		this.context.subscriptions.push(this.statusBar);

		this.dashboard = new Dashboard(this.context, (message) => {
			this.handleDashboardMessage(message);
		});
		this.keyFix = new OpenAiKeyFix(
			this.context,
			(enabled) => {
				this.dashboard.sendKeyFixState(enabled);
				this.updateStatusBar();
			},
			(message) => {
				this.log(message);
			},
			() => {
				return this.isLeaderWindow();
			},
			() => {
				this.scheduleBaseUrlReconcileAfterKeyToggle();
			}
		);
		this.baseUrlWriter = new CursorOpenAiBaseUrlWriter(this.context.globalStorageUri.fsPath, (message) => {
			this.log(`[openai-base-url] ${message}`);
		});

		this.tunnelManager = new TunnelManager(this.windowId, {
			isExtensionHostActive: () => this.extensionHostActive,
			onStateChange: (state) => {
				this.currentTunnelState = state;
				this.dashboard.sendTunnelState(state);
				this.updateStatusBar();
			},
			onLog: (entry) => {
				this.log(`[tunnel] ${entry.message}`);
				this.dashboard.pushLog('tunnel', entry);
			},
			isLocalApiHealthy: async () => {
				return this.checkLocalApiHealth();
			},
			onNeedsApiRecovery: () => {
				void this.recoverApiAndTunnel().catch((err: unknown) => {
					this.log(`[recovery] failed: ${this.formatError(err)}`);
				});
			},
			onTunnelUrl: (url, previousUrl) => {
				void this.handleTunnelUrl(url, previousUrl).catch((err: unknown) => {
					this.log(`[openai-base-url] update failed: ${this.formatError(err)}`);
				});
			}
		});

		this.apiServer = new ApiServer(this.context, {
			onLog: (level: LogEntry['level'], message: string) => {
				this.log(message);
				this.dashboard.pushLog('api', { timestamp: Date.now(), level, message });
			},
			onPortDetected: (port: number) => {
				this.handleApiServerPortDetected(port);
			},
			onStatusChange: (status) => {
				this.handleApiServerStatusChange(status);
			},
			isLeaderWindow: () => {
				return this.isLeaderWindow();
			},
			isExtensionHostActive: () => {
				return this.extensionHostActive;
			},
			getWindowId: () => {
				return this.windowId;
			}
		});

		const openDashboard = vscode.commands.registerCommand(extensionCommands.openDashboard, () => {
			this.dashboard.show();
		});

		const copyTunnelUrl = vscode.commands.registerCommand(extensionCommands.copyTunnelUrl, () => {
			void this.copyTunnelUrlFromCommand();
		});

		const restartTunnel = vscode.commands.registerCommand(extensionCommands.restartTunnel, () => {
			void this.restartTunnelFromStatusBar();
		});
		const toggleKeyFix = vscode.commands.registerCommand(extensionCommands.toggleKeyFix, () => {
			void this.setKeyFixByUser(!this.keyFix.isEnabled());
		});

		this.context.subscriptions.push(openDashboard, copyTunnelUrl, restartTunnel, toggleKeyFix);

		this.startHeartbeat();
		this.startRuntimeSync();
		this.startRuntimeStateWatch();
		this.startBaseUrlReconcile();
		void this.bootstrapRuntime()
			.then(() => this.keyFix.activate())
			.catch((error: unknown) => {
				this.log(`[openai-key-fix] activation failed: ${this.formatError(error)}`);
			});

		this.context.subscriptions.push({
			dispose: () => {
				this.stopBackendServices();
			}
		});
	}

	public stopBackendServices(): void {
		this.extensionHostActive = false;
		void RuntimeStateStore.removeClient(this.windowId).catch(() => {});

		const disposeState = RuntimeStateStore.read();
		if (this.isLeaderWindow(disposeState)) {
			void this.apiServer.stop().catch(() => {});
		}

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = null;
		}

		if (this.baseUrlReconcileTimer) {
			clearInterval(this.baseUrlReconcileTimer);
			this.baseUrlReconcileTimer = null;
		}

		if (this.runtimeStateSyncDebounce) {
			clearTimeout(this.runtimeStateSyncDebounce);
			this.runtimeStateSyncDebounce = null;
		}

		if (this.runtimeStateWatcher) {
			this.runtimeStateWatcher.dispose();
			this.runtimeStateWatcher = null;
		}

		this.keyFix?.stop();
		const stateAfterStop = RuntimeStateStore.read();
		const hasLiveClients = RuntimeStateStore.hasLiveClients(stateAfterStop);

		if (!hasLiveClients) {
			this.tunnelManager?.stop();
		}
	}

	private log(msg: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
	}

	private formatError(err: unknown): string {
		if (err instanceof Error) {
			return err.message;
		}

		return String(err);
	}

	private getTunnelBaseUrl(): string | null {
		return this.currentTunnelState.url;
	}

	private getTunnelApiUrl(): string | null {
		const baseUrl = this.getTunnelBaseUrl();

		if (!baseUrl) {
			return null;
		}

		return `${baseUrl}/v1`;
	}

	private updateStatusBar(): void {
		const apiState = this.lastApiStatus ?? 'stopped';
		const tunnel = this.currentTunnelState;
		const tunnelApiUrl = this.getTunnelApiUrl();
		const keyFixEnabled = this.keyFix?.isEnabled() ?? DEFAULT_KEY_FIX_ENABLED;

		this.statusBar.text = ExtensionStatusBar.barText(apiState, tunnel);
		this.statusBar.tooltip = ExtensionStatusBar.createTooltip(apiState, tunnel, tunnelApiUrl, keyFixEnabled);
		this.statusBar.show();
	}

	private applyApiServerStatus(state: ApiLifecycleStatus): void {
		this.lastApiStatus = state;
		this.updateStatusBar();
	}

	private reportTunnelError(logLine: string, dashboardMessage: string): void {
		this.log(logLine);
		this.dashboard.pushLog('tunnel', { timestamp: Date.now(), level: 'error', message: dashboardMessage });
	}

	private handleApiServerPortDetected(port: number): void {
		const isNew = this.currentPort !== port;
		this.currentPort = port;

		if (isNew) {
			this.log(`[port] detected: ${port}`);
			this.dashboard.setPort(port);
		}

		if (this.lastApiStatus === 'running' && this.tunnelDesired) {
			const tunnelState = this.tunnelManager.getState();

			if (tunnelState.status === 'running' || tunnelState.status === 'starting') {
				void this.tunnelManager.restart(port).catch((err: unknown) => {
					const message = this.formatError(err);
					this.reportTunnelError(`[tunnel] restart failed after port update: ${message}`, `Restart failed: ${message}`);
				});
			} else if (tunnelState.status === 'stopped' || tunnelState.status === 'error') {
				void this.tunnelManager.start(port).catch((err: unknown) => {
					const message = this.formatError(err);
					this.reportTunnelError(`[tunnel] start failed after port update: ${message}`, `Start failed: ${message}`);
				});
			}
		}
	}

	private handleApiServerStatusChange(status: ApiLifecycleStatus): void {
		const previous = this.lastApiStatus;

		if (status === 'stopped' && previous === 'running') {
			this.log(`[health] port ${this.currentPort} unreachable`);
		}

		if ((status === 'error' || status === 'stopped') && previous === 'running' && this.tunnelDesired) {
			this.log('[tunnel] stopping tunnel because API became unhealthy');
			this.tunnelManager.stop();
		}

		this.applyApiServerStatus(status);

		if (status === 'running' && previous !== 'running' && this.tunnelDesired && this.currentPort) {
			const tunnelState = this.tunnelManager.getState();

			if (tunnelState.status !== 'running' && tunnelState.status !== 'starting') {
				this.log(`[tunnel] restarting tunnel after API recovery on port ${this.currentPort}`);
				void this.tunnelManager.start(this.currentPort).catch((err: unknown) => {
					const message = this.formatError(err);
					this.reportTunnelError(`[tunnel] start failed after API recovery: ${message}`, `Start failed: ${message}`);
				});
			}
		}
	}

	private async checkLocalApiHealth(): Promise<boolean> {
		const port = this.currentPort ?? this.apiServer.getPort();

		if (!port) {
			return false;
		}

		try {
			const response = await fetch(`http://localhost:${port}/health`, {
				signal: AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs)
			});

			return response.ok;
		} catch {
			return false;
		}
	}

	private async recoverApiAndTunnel(): Promise<void> {
		if (this.recoveryInProgress || !this.isLeaderWindow()) {
			return;
		}

		this.recoveryInProgress = true;
		this.log('[recovery] restarting API and tunnel after remote health failure');

		try {
			if (this.tunnelDesired) {
				this.tunnelManager.stop();
			}

			await this.apiServer.restart();

			if (this.tunnelDesired && this.currentPort) {
				await this.tunnelManager.start(this.currentPort);
			}
		} finally {
			this.recoveryInProgress = false;
		}
	}

	private async handleTunnelUrl(url: string, previousUrl: string | null): Promise<void> {
		const result = await this.baseUrlWriter.updateFromTunnelUrl(url, previousUrl);

		if (result.status === 'updated') {
			this.log(`[openai-base-url] updated Cursor OpenAI Base URL to ${result.next}`);
			const apiUrl = `${url}/v1`;
			const action = await vscode.window.showInformationMessage(
				`Updated Cursor OpenAI Base URL to ${result.next}`,
				'Copy URL',
				'Reload Window'
			);

			if (action === 'Copy URL') {
				await vscode.env.clipboard.writeText(apiUrl);
			} else if (action === 'Reload Window') {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			}

			return;
		}

		if (result.status === 'failed') {
			this.log(`[openai-base-url] failed: ${result.reason}`);
			const apiUrl = `${url}/v1`;
			const action = await vscode.window.showWarningMessage(
				`Could not auto-update Cursor OpenAI Base URL (${result.reason}). New tunnel: ${apiUrl}`,
				'Copy URL',
				'Reload Window'
			);

			if (action === 'Copy URL') {
				await vscode.env.clipboard.writeText(apiUrl);
			} else if (action === 'Reload Window') {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			}

			return;
		}

		this.log(`[openai-base-url] skipped: ${result.reason}`);
	}

	private restartTunnelFromStatusBar(): void {
		const runtimeState = RuntimeStateStore.read();
		const runtimePort = runtimeState.api.port ?? this.currentPort;

		if (!runtimePort) {
			void vscode.window.showWarningMessage('Cannot start tunnel: API is not running yet.');

			return;
		}

		const port = runtimePort;

		this.tunnelDesired = true;
		this.log(`[tunnel] restart requested from status bar (port ${port})`);
		this.enqueueCommand('restart-tunnel');
	}

	private async waitForTunnelUrl(timeoutMs = config.extensionController.tunnelWaitTimeoutMs): Promise<string> {
		const startedAt = Date.now();

		while (Date.now() - startedAt < timeoutMs) {
			const state = this.tunnelManager.getState();

			if (state.status === 'running' && state.url) {
				return state.url;
			}

			if (state.status === 'error') {
				throw new Error(state.error ?? 'Tunnel failed to start.');
			}

			await sleep(config.extensionController.tunnelWaitPollIntervalMs);
		}

		throw new Error('Timed out while waiting for tunnel URL.');
	}

	private async copyTunnelUrlFromCommand(): Promise<void> {
		const url = this.getTunnelApiUrl();

		if (!url) {
			void vscode.window.showWarningMessage('No tunnel URL yet. Start the tunnel from the menu or dashboard.');

			return;
		}

		await vscode.env.clipboard.writeText(url);
		void vscode.window.showInformationMessage('Tunnel URL copied to clipboard.');
	}

	private handleDashboardMessage(message: Msg): void {
		if (message.type === 'open-external-url') {
			void vscode.env.openExternal(vscode.Uri.parse(message.url));

			return;
		}

		if (message.type === 'webview-ready') {
			this.dashboard.sendInitialState(this.tunnelManager.getState());
			this.dashboard.sendKeyFixState(this.keyFix.isEnabled());

			return;
		}

		if (message.type === 'restart-server') {
			this.enqueueCommand('restart-api');

			return;
		}

		if (message.type === 'start-tunnel') {
			this.tunnelDesired = true;
			this.enqueueCommand('start-tunnel');

			return;
		}

		if (message.type === 'stop-tunnel') {
			this.tunnelDesired = false;
			this.enqueueCommand('stop-tunnel');

			return;
		}

		if (message.type === 'restart-tunnel') {
			this.tunnelDesired = true;
			this.enqueueCommand('restart-tunnel');

			return;
		}

		if (message.type === 'set-key-fix-enabled') {
			void this.setKeyFixByUser(message.enabled);

			return;
		}

		if (message.type === 'clear-logs') {
			this.dashboard.clearLogs(message.source);
			this.enqueueCommand('clear-logs', { logSource: message.source });
		}
	}

	private async setKeyFixByUser(enabled: boolean): Promise<void> {
		try {
			await this.keyFix.setEnabledByUser(enabled);
		} catch (error: unknown) {
			void vscode.window.showErrorMessage(`OpenAI API Key auto-fix unavailable: ${this.formatError(error)}`);
			this.dashboard.sendKeyFixState(false);
			this.updateStatusBar();

			return;
		}

		this.dashboard.sendKeyFixState(enabled);
		this.updateStatusBar();
		let message = 'OpenAI API Key auto-fix disabled.';

		if (enabled) {
			message = 'OpenAI API Key auto-fix enabled.';
		}

		void vscode.window.showInformationMessage(message);
	}

	private handleDashboardStartTunnel(): void {
		this.tunnelDesired = true;

		if (this.currentPort) {
			this.log(`[tunnel] start requested on port ${this.currentPort}`);
			void this.tunnelManager.start(this.currentPort).catch((err: unknown) => {
				const message = this.formatError(err);
				this.reportTunnelError(`[tunnel] start failed: ${message}`, `Start failed: ${message}`);
			});

			return;
		}

		this.log('[tunnel] start requested but no port available');
		this.dashboard.pushLog('tunnel', {
			timestamp: Date.now(),
			level: 'error',
			message: 'Cannot start tunnel: API not running'
		});
	}

	private handleDashboardRestartTunnel(): void {
		if (!this.currentPort) {
			return;
		}

		this.tunnelDesired = true;
		void this.tunnelManager.restart(this.currentPort).catch((err: unknown) => {
			const message = this.formatError(err);
			this.reportTunnelError(`[tunnel] restart failed: ${message}`, `Restart failed: ${message}`);
		});
	}

	private startHeartbeat(): void {
		void RuntimeStateStore.touchClient(this.windowId).catch(() => {});
		this.heartbeatTimer = setInterval(() => {
			void RuntimeStateStore.touchClient(this.windowId).catch(() => {});
		}, config.extensionController.heartbeatIntervalMs);
	}

	private startRuntimeSync(): void {
		this.syncTimer = setInterval(() => {
			void this.syncFromRuntimeState().catch(() => {});
		}, config.extensionController.runtimeSyncIntervalMs);
	}

	private startBaseUrlReconcile(): void {
		this.baseUrlReconcileTimer = setInterval(() => {
			void this.reconcileBaseUrl().catch(() => {});
		}, config.extensionController.baseUrlReconcileIntervalMs);
	}

	private scheduleBaseUrlReconcileAfterKeyToggle(): void {
		setTimeout(() => {
			void this.reconcileBaseUrl().catch(() => {});
		}, config.extensionController.baseUrlReconcileAfterKeyToggleMs);
	}

	private async reconcileBaseUrl(): Promise<void> {
		if (this.baseUrlReconcileInFlight || !this.isLeaderWindow()) {
			return;
		}

		if (this.currentTunnelState.status !== 'running') {
			return;
		}

		const apiUrl = this.getTunnelApiUrl();

		if (!apiUrl) {
			return;
		}

		this.baseUrlReconcileInFlight = true;

		try {
			const result = await this.baseUrlWriter.ensureBaseUrl(apiUrl);

			if (result.status === 'updated') {
				this.log(`[openai-base-url] reconciled Cursor OpenAI Base URL back to ${result.next}`);
			}
		} catch (err: unknown) {
			this.log(`[openai-base-url] reconcile failed: ${this.formatError(err)}`);
		} finally {
			this.baseUrlReconcileInFlight = false;
		}
	}

	private startRuntimeStateWatch(): void {
		const stateFileName = path.basename(config.paths.stateFilePath);

		this.runtimeStateWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(config.baseDir), stateFileName)
		);

		const scheduleSync = (): void => {
			if (this.runtimeStateSyncDebounce) {
				clearTimeout(this.runtimeStateSyncDebounce);
			}

			this.runtimeStateSyncDebounce = setTimeout(() => {
				this.runtimeStateSyncDebounce = null;
				void this.syncFromRuntimeState().catch(() => {});
			}, 100);
		};

		this.runtimeStateWatcher.onDidChange(scheduleSync);
		this.runtimeStateWatcher.onDidCreate(scheduleSync);
	}

	private async bootstrapRuntime(): Promise<void> {
		await RuntimeStateStore.touchClient(this.windowId);
		const runtimeState = await RuntimeStateStore.prepareApiForBootstrap();

		if (runtimeState.tunnel.status === 'running' || runtimeState.tunnel.status === 'starting') {
			this.tunnelDesired = true;
		}

		this.startApiAsLeaderIfNeeded(runtimeState);
		await this.syncFromRuntimeState();
	}

	private async syncFromRuntimeState(): Promise<void> {
		let runtimeState = RuntimeStateStore.read();
		const liveClientIds = RuntimeStateStore.getLiveClientIds(runtimeState);

		if (!liveClientIds.includes(this.windowId)) {
			runtimeState = await RuntimeStateStore.touchClient(this.windowId);
		}

		await this.keyFix.applySharedState(runtimeState.keyFix.enabled);
		this.applyRuntimeState(runtimeState);
		this.apiServer.syncLeaderHealthMonitor(this.isLeaderWindow(runtimeState));
		this.tryHandleCommand(runtimeState);
	}

	private applyRuntimeState(runtimeState: RuntimeState): void {
		const resolvedPort = runtimeState.api.port ?? this.apiServer.getPort() ?? this.currentPort;

		this.currentPort = resolvedPort;
		this.lastApiStatus = runtimeState.api.status;
		this.currentTunnelState = {
			status: runtimeState.tunnel.status,
			url: runtimeState.tunnel.url,
			error: runtimeState.tunnel.lastError
		};
		this.dashboard.setPort(this.currentPort);
		this.dashboard.sendTunnelState(this.currentTunnelState);
		this.dashboard.sendKeyFixState(this.keyFix.isEnabled());
		this.updateStatusBar();
	}

	private enqueueCommand(action: RuntimeCommandAction, payload: { port?: number; logSource?: 'api' | 'tunnel' } = {}): void {
		void RuntimeStateStore.enqueueCommand({
			id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
			action,
			createdAt: Date.now(),
			originWindowId: this.windowId,
			payload: {
				port: this.currentPort ?? undefined,
				...payload
			}
		}).catch(() => {});
	}

	private tryHandleCommand(runtimeState: RuntimeState): void {
		const command = RuntimeStateStore.peekCommand();

		if (!command) {
			return;
		}

		if (command.id === this.lastCommandId) {
			return;
		}

		if (command.originWindowId === this.windowId) {
			this.lastCommandId = command.id;
		}

		const tunnelOwner = runtimeState.tunnel.ownerWindowId;
		const shouldHandleTunnelCommand =
			!tunnelOwner || tunnelOwner === this.windowId || !RuntimeStateStore.getLiveClientIds(runtimeState).includes(tunnelOwner);

		if (command.action === 'restart-api') {
			if (!this.isLeaderWindow(runtimeState)) {
				return;
			}

			void this.apiServer.restart().catch((err: unknown) => {
				this.log(`[process] restart-api failed: ${this.formatError(err)}`);
			});
			this.ackCommand(command.id);

			return;
		}

		if (command.action === 'clear-logs') {
			const logSource = command.payload?.logSource;

			if (logSource === 'api' || logSource === 'tunnel') {
				this.dashboard.clearLogs(logSource);
			}

			this.ackCommand(command.id);

			return;
		}

		if (!shouldHandleTunnelCommand) {
			return;
		}

		if (command.action === 'start-tunnel') {
			this.tunnelDesired = true;

			if (this.currentPort) {
				void this.tunnelManager.start(this.currentPort).catch((err: unknown) => {
					const message = this.formatError(err);
					this.reportTunnelError(`[tunnel] start failed: ${message}`, `Start failed: ${message}`);
				});
			}

			this.ackCommand(command.id);

			return;
		}

		if (command.action === 'stop-tunnel') {
			this.tunnelDesired = false;
			this.tunnelManager.stop();
			this.ackCommand(command.id);

			return;
		}

		if (command.action === 'restart-tunnel') {
			this.tunnelDesired = true;
			const commandPort = command.payload?.port ?? this.currentPort;
			if (commandPort) {
				void this.tunnelManager.restart(commandPort).catch((err: unknown) => {
					const message = this.formatError(err);
					this.reportTunnelError(`[tunnel] restart failed: ${message}`, `Restart failed: ${message}`);
				});
			}

			this.ackCommand(command.id);
		}
	}

	private ackCommand(commandId: string): void {
		this.lastCommandId = commandId;
		void RuntimeStateStore.removeCommand(commandId).catch(() => {});
	}

	private isLeaderWindow(runtimeState?: RuntimeState): boolean {
		const state = runtimeState ?? RuntimeStateStore.read();
		const leaderWindowId = RuntimeStateStore.getLeaderWindowId(state);

		return leaderWindowId === this.windowId;
	}

	private startApiAsLeaderIfNeeded(runtimeState: RuntimeState): void {
		if (!this.isLeaderWindow(runtimeState)) {
			return;
		}

		if (this.apiServer.getPort() || this.apiServer.isStartupInProgress()) {
			return;
		}

		if (RuntimeStateStore.isApiStartSuppressed(runtimeState)) {
			return;
		}

		void this.apiServer.start().catch((err: unknown) => {
			const message = this.formatError(err);
			this.log(`[process] leader start failed: ${message}`);
			this.dashboard.pushLog('api', { timestamp: Date.now(), level: 'error', message });
			this.applyApiServerStatus('error');
		});
	}
}
