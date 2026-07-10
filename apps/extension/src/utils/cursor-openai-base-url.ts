import * as fs from 'node:fs';
import * as path from 'node:path';

import { CursorStateDbReader } from './cursor-state-db-reader';

const REACTIVE_STORAGE_KEY =
	'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

const TRYCLOUDFLARE_HOST = /\.trycloudflare\.com(?:\/|$)/i;

export type OpenAiBaseUrlUpdateResult =
	| { status: 'updated'; previous: string | null; next: string }
	| { status: 'skipped'; reason: string }
	| { status: 'failed'; reason: string };

interface ReactiveStorageState {
	openAIBaseUrl?: string | null;
	[key: string]: unknown;
}

export function shouldUpdateOpenAiBaseUrl(current: string | null | undefined, previousTunnelApiUrl: string | null): boolean {
	if (current == null || current === '') {
		return true;
	}

	if (previousTunnelApiUrl && current === previousTunnelApiUrl) {
		return true;
	}

	return TRYCLOUDFLARE_HOST.test(current);
}

export function toTunnelApiUrl(tunnelUrl: string): string {
	return `${tunnelUrl.replace(/\/$/, '')}/v1`;
}

export class CursorOpenAiBaseUrlWriter {
	private readonly stateDbPath: string;
	private readonly stateDbReader = new CursorStateDbReader((message) => this.onLog?.(message));
	private readerUnavailableReason: string | null = null;

	constructor(
		globalStorageUriFsPath: string,
		private readonly onLog?: (message: string) => void
	) {
		this.stateDbPath = path.join(path.dirname(globalStorageUriFsPath), 'state.vscdb');
	}

	async updateFromTunnelUrl(tunnelUrl: string, previousTunnelUrl: string | null): Promise<OpenAiBaseUrlUpdateResult> {
		const next = toTunnelApiUrl(tunnelUrl);
		const previousApiUrl = previousTunnelUrl ? toTunnelApiUrl(previousTunnelUrl) : null;
		const unavailableReason = await this.refreshReaderAvailability();

		if (unavailableReason) {
			return { status: 'failed', reason: unavailableReason };
		}

		try {
			const raw = await this.stateDbReader.readItemTableValue(this.stateDbPath, REACTIVE_STORAGE_KEY);

			if (!raw) {
				return { status: 'failed', reason: 'Cursor reactive storage blob not found' };
			}

			const parsed = JSON.parse(raw) as ReactiveStorageState;
			const current = typeof parsed.openAIBaseUrl === 'string' ? parsed.openAIBaseUrl : (parsed.openAIBaseUrl ?? null);

			if (!shouldUpdateOpenAiBaseUrl(current, previousApiUrl)) {
				return {
					status: 'skipped',
					reason: `Current OpenAI Base URL is not an Ungate tunnel (${String(current)})`
				};
			}

			if (current === next) {
				return { status: 'skipped', reason: 'OpenAI Base URL already matches tunnel' };
			}

			parsed.openAIBaseUrl = next;
			await this.stateDbReader.writeItemTableValue(this.stateDbPath, REACTIVE_STORAGE_KEY, JSON.stringify(parsed));

			return { status: 'updated', previous: current, next };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);

			return { status: 'failed', reason };
		}
	}

	private async refreshReaderAvailability(): Promise<string | null> {
		if (!fs.existsSync(this.stateDbPath)) {
			this.readerUnavailableReason = 'state.vscdb not found';

			return this.readerUnavailableReason;
		}

		this.readerUnavailableReason = await this.stateDbReader.init();

		return this.readerUnavailableReason;
	}
}
