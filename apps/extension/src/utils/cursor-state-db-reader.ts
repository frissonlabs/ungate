import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Sqlite3CliResolver } from './sqlite3-cli-resolver';

const execFileAsync = promisify(execFile);

export const SQLITE_CLI_UNAVAILABLE_REASON = 'SQLite CLI could not be prepared';

type InstallLogger = (message: string) => void;

const WRITE_RETRY_ATTEMPTS = 3;
const WRITE_RETRY_DELAY_MS = 100;
// Cursor keeps state.vscdb open in WAL mode across every window, so a bare
// UPDATE frequently collides with its lock. The sqlite3 CLI defaults to
// busy_timeout=0 (fail immediately), so we set a timeout to let the write
// block until Cursor releases the lock instead of throwing straight away.
const BUSY_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function isLockError(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

	return message.includes('busy') || message.includes('locked');
}

export class CursorStateDbReader {
	private cliPath: string | null = null;
	private initResult: string | null | undefined;

	constructor(private readonly onLog?: InstallLogger) {}

	async init(): Promise<string | null> {
		if (this.initResult !== undefined) {
			return this.initResult;
		}

		this.cliPath = await Sqlite3CliResolver.resolve(this.onLog);
		this.initResult = this.cliPath ? null : SQLITE_CLI_UNAVAILABLE_REASON;

		return this.initResult;
	}

	async readItemTableValue(dbPath: string, key: string): Promise<string | null> {
		if (!this.cliPath) {
			return null;
		}

		const escapedKey = key.replaceAll("'", "''");
		const query = `SELECT value FROM ItemTable WHERE key = '${escapedKey}';`;
		const { stdout } = await this.execWithBusyTimeout(dbPath, query);
		const raw = stdout.trim();

		return raw || null;
	}

	async writeItemTableValue(dbPath: string, key: string, value: string): Promise<void> {
		if (!this.cliPath) {
			throw new Error(SQLITE_CLI_UNAVAILABLE_REASON);
		}

		const escapedKey = key.replaceAll("'", "''");
		const escapedValue = value.replaceAll("'", "''");
		const query = `UPDATE ItemTable SET value = '${escapedValue}' WHERE key = '${escapedKey}';`;

		let lastError: unknown = null;

		for (let attempt = 0; attempt < WRITE_RETRY_ATTEMPTS; attempt += 1) {
			try {
				await this.execWithBusyTimeout(dbPath, query);

				return;
			} catch (error) {
				lastError = error;

				if (!isLockError(error)) {
					throw error;
				}

				await sleep(WRITE_RETRY_DELAY_MS * (attempt + 1));
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private execWithBusyTimeout(dbPath: string, query: string): Promise<{ stdout: string; stderr: string }> {
		if (!this.cliPath) {
			throw new Error(SQLITE_CLI_UNAVAILABLE_REASON);
		}

		// `.timeout` sets the busy handler without emitting output (unlike
		// `PRAGMA busy_timeout`, which would print a row and pollute reads).
		return execFileAsync(this.cliPath, ['-cmd', `.timeout ${BUSY_TIMEOUT_MS}`, dbPath, query]);
	}
}
