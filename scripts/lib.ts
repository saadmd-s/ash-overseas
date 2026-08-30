/**
 * Shared helpers for the maintenance scripts.
 *
 * Requires Node 22.18+ or 24+ — these files are TypeScript and rely on the
 * runtime's native type stripping, so there is no build step between editing a
 * script and running it.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * wrangler's own entry script, invoked through `node` directly.
 *
 * NOT `pnpm exec wrangler` with `shell: true`. On Windows that route re-parses
 * the argument list, and a `--command "SELECT a, b FROM t"` arrives at wrangler
 * split on every space — which fails as "Unknown arguments: a,, b, FROM, t"
 * rather than as anything resembling the real problem. Spawning node with an
 * explicit argv keeps every argument intact on every platform.
 */
const WRANGLER = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');

export interface RunOptions {
  /** Capture stdout instead of streaming it to the terminal. */
  capture?: boolean;
  /** Return the failure instead of exiting. */
  allowFailure?: boolean;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

export function wrangler(args: string[], options: RunOptions = {}): RunResult {
  const run = spawnSync(process.execPath, [WRANGLER, ...args], {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  const result: RunResult = {
    ok: run.status === 0,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
  };

  if (!result.ok && !options.allowFailure) {
    if (options.capture) console.error(result.stdout, result.stderr);
    fail(`wrangler ${args.slice(0, 3).join(' ')} failed.`);
  }
  return result;
}

/**
 * Pull the JSON payload out of wrangler's output.
 *
 * `--json` still leaves banner and log lines around the data on some commands,
 * so the array is located rather than assumed to be the whole of stdout.
 */
export function parseJsonArray<T>(output: string, what: string): T[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start < 0 || end < start) fail(`Could not read ${what} from wrangler.\n${output}`);

  try {
    return JSON.parse(output.slice(start, end + 1)) as T[];
  } catch {
    return fail(`Could not parse ${what} from wrangler.\n${output}`);
  }
}
