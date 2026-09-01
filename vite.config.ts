import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';

/**
 * Loosen the §16.2 Content-Security-Policy for `vite dev` only.
 *
 * WHY THIS EXISTS. `run_worker_first: true` (wrangler.jsonc, and it must stay
 * true) means the Worker runs ahead of the assets service, so the six security
 * headers land on the HTML document as well as on API responses. That is the
 * whole point of it in production. In dev it collides with Vite:
 * `@vitejs/plugin-react` injects its Fast Refresh preamble as an INLINE
 * `<script type="module">`, `default-src 'self'` blocks it, and the plugin then
 * throws "can't detect preamble" — a blank page and two console errors that
 * look like an application fault and are not one.
 *
 * WHY IT LIVES HERE rather than behind a flag in src/worker/auth.ts. This file
 * is dev-server configuration; it is never bundled into the Worker and never
 * deployed. So SECURITY_HEADERS keeps exactly one value, the assertion in
 * auth.test.ts keeps checking the string that actually ships, and no runtime
 * branch exists in production that could be reached by mistake. The relaxation
 * is not disabled in production — it is absent from it.
 *
 * The build output is the case that matters and never needed this: the
 * production bundle contains no inline script at all.
 */
const CSP = 'content-security-policy';

const DEV_CSP = [
  // 'unsafe-inline' for the React Fast Refresh preamble.
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  // Vite injects <style> blocks for HMR'd CSS.
  "style-src 'self' 'unsafe-inline'",
  // The HMR websocket.
  "connect-src 'self' ws: wss:",
  // Unchanged from production — nothing about dev needs these loosened.
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function devCsp(): Plugin {
  return {
    name: 'ash-dev-csp',
    apply: 'serve',
    // 'pre' matters: configureServer hooks install middleware in plugin order,
    // and the Cloudflare plugin's middleware answers the request without
    // calling next(). Registered after it, this one is never reached.
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        // The Cloudflare plugin copies the Worker's Response headers onto the
        // Node response, and it does not use a single path to do it. Both are
        // intercepted: `setHeader` for a header set individually, `writeHead`
        // for a batch handed over at flush time. Patching only the first
        // silently does nothing — which is what happened on the first attempt.
        const setHeader = res.setHeader.bind(res);
        res.setHeader = function (name: string, value: number | string | readonly string[]) {
          return setHeader(name, name.toLowerCase() === CSP ? DEV_CSP : value);
        } as typeof res.setHeader;

        const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => typeof res;
        res.writeHead = function (statusCode: number, ...rest: unknown[]) {
          for (const arg of rest) {
            if (Array.isArray(arg)) {
              // The flat [name, value, name, value] form.
              for (let i = 0; i + 1 < arg.length; i += 2) {
                if (String(arg[i]).toLowerCase() === CSP) arg[i + 1] = DEV_CSP;
              }
            } else if (arg && typeof arg === 'object') {
              const headers = arg as Record<string, unknown>;
              for (const key of Object.keys(headers)) {
                if (key.toLowerCase() === CSP) headers[key] = DEV_CSP;
              }
            }
          }
          return writeHead(statusCode, ...rest);
        } as typeof res.writeHead;

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [devCsp(), react(), tailwindcss(), cloudflare()],
});
