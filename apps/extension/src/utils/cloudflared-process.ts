import { execFileSync } from 'node:child_process';

export function isProcessAlive(pid: number | null | undefined): boolean {
	if (!pid || pid <= 0) {
		return false;
	}

	try {
		process.kill(pid, 0);

		return true;
	} catch {
		return false;
	}
}

export function killProcess(pid: number, signal: NodeJS.Signals = 'SIGINT'): boolean {
	if (!isProcessAlive(pid)) {
		return false;
	}

	try {
		process.kill(pid, signal);

		return true;
	} catch {
		return false;
	}
}

export function findCloudflaredPidsForPort(port: number): number[] {
	try {
		const stdout = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
			encoding: 'utf8',
			timeout: 3000
		});
		const needle = `localhost:${port}`;
		const pids: number[] = [];

		for (const line of stdout.split('\n')) {
			const match = /^\s*(\d+)\s+(.*)$/.exec(line);

			if (!match) {
				continue;
			}

			const pid = Number.parseInt(match[1], 10);
			const command = match[2];

			if (!Number.isFinite(pid) || pid <= 0) {
				continue;
			}

			if (command.includes('cloudflared') && command.includes(needle)) {
				pids.push(pid);
			}
		}

		return pids;
	} catch {
		return [];
	}
}
