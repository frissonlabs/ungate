import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		existsSyncMock: vi.fn(),
		initMock: vi.fn(),
		readItemTableValueMock: vi.fn(),
		writeItemTableValueMock: vi.fn()
	};
});

vi.mock('node:fs', () => {
	return {
		existsSync: mocks.existsSyncMock
	};
});

vi.mock('../../src/utils/cursor-state-db-reader', () => {
	return {
		CursorStateDbReader: class {
			init = mocks.initMock;
			readItemTableValue = mocks.readItemTableValueMock;
			writeItemTableValue = mocks.writeItemTableValueMock;
		}
	};
});

import { CursorOpenAiBaseUrlWriter, shouldUpdateOpenAiBaseUrl, toTunnelApiUrl } from '../../src/utils/cursor-openai-base-url';

describe('shouldUpdateOpenAiBaseUrl', () => {
	it('allows null or empty current values', () => {
		expect(shouldUpdateOpenAiBaseUrl(null, null)).toBe(true);
		expect(shouldUpdateOpenAiBaseUrl('', null)).toBe(true);
	});

	it('allows previous Ungate tunnel URL matches', () => {
		expect(shouldUpdateOpenAiBaseUrl('https://old.trycloudflare.com/v1', 'https://old.trycloudflare.com/v1')).toBe(true);
	});

	it('allows any trycloudflare URL', () => {
		expect(shouldUpdateOpenAiBaseUrl('https://other.trycloudflare.com/v1', null)).toBe(true);
	});

	it('preserves unrelated custom endpoints', () => {
		expect(shouldUpdateOpenAiBaseUrl('https://api.example.com/v1', null)).toBe(false);
	});
});

describe('CursorOpenAiBaseUrlWriter', () => {
	beforeEach(() => {
		mocks.existsSyncMock.mockReset();
		mocks.initMock.mockReset();
		mocks.readItemTableValueMock.mockReset();
		mocks.writeItemTableValueMock.mockReset();
		mocks.existsSyncMock.mockReturnValue(true);
		mocks.initMock.mockResolvedValue(null);
	});

	it('updates openAIBaseUrl for trycloudflare values', async () => {
		const oldBlob = JSON.stringify({ useOpenAIKey: true, openAIBaseUrl: 'https://old.trycloudflare.com/v1' });
		const newBlob = JSON.stringify({ useOpenAIKey: true, openAIBaseUrl: 'https://new.trycloudflare.com/v1' });
		// Reads: initial current-value read, write-loop read, then verify read.
		mocks.readItemTableValueMock.mockResolvedValueOnce(oldBlob).mockResolvedValueOnce(oldBlob).mockResolvedValueOnce(newBlob);
		mocks.writeItemTableValueMock.mockResolvedValue(undefined);

		const writer = new CursorOpenAiBaseUrlWriter('/tmp/globalStorage/ext');
		const result = await writer.updateFromTunnelUrl('https://new.trycloudflare.com', 'https://old.trycloudflare.com');

		expect(result).toEqual({
			status: 'updated',
			previous: 'https://old.trycloudflare.com/v1',
			next: 'https://new.trycloudflare.com/v1'
		});
		expect(mocks.writeItemTableValueMock).toHaveBeenCalledWith(
			'/tmp/globalStorage/state.vscdb',
			'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
			expect.stringContaining('"openAIBaseUrl":"https://new.trycloudflare.com/v1"')
		);
	});

	it('retries the write when Cursor clobbers the value back', async () => {
		const oldBlob = JSON.stringify({ useOpenAIKey: true, openAIBaseUrl: 'https://old.trycloudflare.com/v1' });
		const newBlob = JSON.stringify({ useOpenAIKey: true, openAIBaseUrl: 'https://new.trycloudflare.com/v1' });
		mocks.readItemTableValueMock
			// initial current-value read
			.mockResolvedValueOnce(oldBlob)
			// attempt 1: read before write, then verify read still shows the old value
			.mockResolvedValueOnce(oldBlob)
			.mockResolvedValueOnce(oldBlob)
			// attempt 2: read before write, then verify read confirms the new value
			.mockResolvedValueOnce(oldBlob)
			.mockResolvedValueOnce(newBlob);
		mocks.writeItemTableValueMock.mockResolvedValue(undefined);

		const writer = new CursorOpenAiBaseUrlWriter('/tmp/globalStorage/ext');
		const result = await writer.updateFromTunnelUrl('https://new.trycloudflare.com', 'https://old.trycloudflare.com');

		expect(result.status).toBe('updated');
		expect(mocks.writeItemTableValueMock).toHaveBeenCalledTimes(2);
	});

	it('reports failure when the write never persists', async () => {
		const oldBlob = JSON.stringify({ useOpenAIKey: true, openAIBaseUrl: 'https://old.trycloudflare.com/v1' });
		// Every read keeps returning the stale value, so verification never passes.
		mocks.readItemTableValueMock.mockResolvedValue(oldBlob);
		mocks.writeItemTableValueMock.mockResolvedValue(undefined);

		const writer = new CursorOpenAiBaseUrlWriter('/tmp/globalStorage/ext');
		const result = await writer.updateFromTunnelUrl('https://new.trycloudflare.com', 'https://old.trycloudflare.com');

		expect(result.status).toBe('failed');
	});

	it('re-asserts a known url via ensureBaseUrl', async () => {
		const staleBlob = JSON.stringify({ useOpenAIKey: true, openAIBaseUrl: 'https://old.trycloudflare.com/v1' });
		const freshBlob = JSON.stringify({ useOpenAIKey: true, openAIBaseUrl: 'https://new.trycloudflare.com/v1' });
		mocks.readItemTableValueMock
			.mockResolvedValueOnce(staleBlob)
			.mockResolvedValueOnce(staleBlob)
			.mockResolvedValueOnce(freshBlob);
		mocks.writeItemTableValueMock.mockResolvedValue(undefined);

		const writer = new CursorOpenAiBaseUrlWriter('/tmp/globalStorage/ext');
		const result = await writer.ensureBaseUrl('https://new.trycloudflare.com/v1');

		expect(result.status).toBe('updated');
		expect(mocks.writeItemTableValueMock).toHaveBeenCalledWith(
			'/tmp/globalStorage/state.vscdb',
			'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
			expect.stringContaining('"openAIBaseUrl":"https://new.trycloudflare.com/v1"')
		);
	});

	it('skips unrelated custom base URLs', async () => {
		mocks.readItemTableValueMock.mockResolvedValue(
			JSON.stringify({ useOpenAIKey: true, openAIBaseUrl: 'https://api.example.com/v1' })
		);

		const writer = new CursorOpenAiBaseUrlWriter('/tmp/globalStorage/ext');
		const result = await writer.updateFromTunnelUrl('https://new.trycloudflare.com', null);

		expect(result.status).toBe('skipped');
		expect(mocks.writeItemTableValueMock).not.toHaveBeenCalled();
	});

	it('builds tunnel api urls with /v1', () => {
		expect(toTunnelApiUrl('https://x.trycloudflare.com/')).toBe('https://x.trycloudflare.com/v1');
	});
});
