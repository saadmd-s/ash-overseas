/**
 * Deploy to production — SRS §19.2.
 *
 * THIS SCRIPT EXISTS BECAUSE THE OBVIOUS ONE-LINER IS WRONG, and wrong in a way
 * that ships a working-looking site with the safety rails off.
 *
 * `deploy:prod` used to be:
 *
 *     require-auth-secret && vite build && wrangler deploy --env production
 *
 * With `@cloudflare/vite-plugin`, `vite build` resolves the Worker
 * configuration at BUILD time and writes it to `dist/<name>/wrangler.json`,
 * then points `.wrangler/deploy/config.json` at that file. `wrangler deploy`
 * reads the built config. So `--env production` arrives far too late: the
 * environment was already baked in at build time, and the flag silently does
 * nothing.
 *
 * The first real deploy of this project went out that way. It reported success
 * and printed:
 *
 *     env.DB (ledger-dev)            D1 Database
 *     env.APP_ENV ("development")    Environment Variable
 *
 * — the DEVELOPMENT database, and `APP_ENV=development`, which is the value
 * that disables the fail-closed check in src/worker/index.ts. With AUTH_SECRET
 * unset, that combination does not refuse to serve; it serves the ledger with
 * the sign-in gate DISABLED. Two independent safety mechanisms both came down
 * to one environment variable, and one ignored flag turned it off.
 *
 * The environment is therefore selected the only way that actually works:
 * `CLOUDFLARE_ENV` in the build's environment. It is set here rather than in
 * package.json because `VAR=value cmd` is not portable — on Windows, where this
 * project is developed, it is a syntax error rather than an assignment.
 *
 * After the build, `wrangler deploy` takes NO `--env` flag: the config it reads
 * is already the production one, and passing the flag would send it looking for
 * an `env.production` block inside an artefact that has none.
 *
 * Requires Node 22.18+ or 24+ (native TypeScript type stripping).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail } from './lib.ts';

const ENV = 'production';

/**
 * `shell` is per-call and not a blanket `process.platform === 'win32'`.
 *
 * On Windows `pnpm` is `pnpm.cmd` and cannot be spawned without a shell. But
 * running node THROUGH a shell breaks on this very machine: `process.execPath`
 * is `C:\Program Files\nodejs\node.exe`, the shell splits it at the space, and
 * you get `'C:\Program' is not recognized`. Each command gets what it needs.
 */
function run(
  command: string,
  args: string[],
  { env, shell = false }: { env?: NodeJS.ProcessEnv; shell?: boolean } = {},
): void {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed.`);
}

// 1. The secret must be set — or this must be the first deploy, which creates
//    the Worker that the secret can then be attached to.
run(process.execPath, ['scripts/require-auth-secret.ts', '--env', ENV]);

// 2. Build FOR production. This is the step that chooses the environment.
run('pnpm', ['exec', 'vite', 'build'], { env: { CLOUDFLARE_ENV: ENV }, shell: true });

/**
 * 3. Verify what was actually built before it goes anywhere.
 *
 * The failure this guards against was silent: a successful build and a
 * successful deploy, with the wrong bindings. Reading the generated config back
 * and asserting on it is the only check that would have caught it, so it is not
 * optional politeness — it is the whole lesson of this file.
 */
// The build output directory is derived from the TOP-LEVEL worker name, not
// from the environment being built, so it must not be hardcoded here. This is
// the same pointer file `wrangler deploy` itself follows.
const pointer = JSON.parse(readFileSync(join('.wrangler', 'deploy', 'config.json'), 'utf8')) as {
  configPath: string;
};
const builtConfigPath = resolve('.wrangler', 'deploy', pointer.configPath);

const built = JSON.parse(readFileSync(builtConfigPath, 'utf8')) as {
  name?: string;
  vars?: Record<string, unknown>;
  d1_databases?: { database_name?: string }[];
};

const appEnv = built.vars?.APP_ENV;
const database = built.d1_databases?.[0]?.database_name;

if (appEnv !== ENV || database !== 'ledger-prod') {
  fail(
    [
      'The build did not resolve to the production environment. Refusing to deploy.',
      '',
      `  APP_ENV   ${String(appEnv)}   (expected "${ENV}")`,
      `  database  ${String(database)}   (expected "ledger-prod")`,
      '',
      '  This is the CLOUDFLARE_ENV trap. See the note at the top of this file.',
    ].join('\n'),
  );
}

console.log(`- Built for ${ENV}: worker "${built.name}", database ${database}.`);

// 4. No --env here. The built config is already the production one.
run('pnpm', ['exec', 'wrangler', 'deploy'], { shell: true });
