import type { InlineConfig, Plugin } from 'vite';
import type { ExtensionOptions } from './types';
import { builtinModules } from 'node:module';
import { execa } from 'execa';
import colors from 'picocolors';
import { build as viteBuild } from 'vite';
import { PLUGIN_NAME } from './constants';
import { logger } from './logger';

const DEFAULT_IGNORE_WATCH = ['.history', '.temp', '.tmp', '.cache', 'dist'];

/**
 * ESM shim that reproduces the previous tsdown `shims` behavior.
 *
 * `__dirname` / `__filename` do not exist in ESM; they are computed from
 * `import.meta.url` and injected into the bundle via the output banner.
 *
 * The shim is intentionally free of top-level imports/bindings so it can never
 * collide with the bundled code (e.g. `import path from "node:path"`).
 */
const ESM_SHIMS = [
  `import { dirname as __tomjs_dirname } from 'node:path';`,
  `import { fileURLToPath as __tomjs_fileURLToPath } from 'node:url';`,
  `const __dirname = import.meta.dirname ?? __tomjs_dirname(__tomjs_fileURLToPath(import.meta.url));`,
  `const __filename = import.meta.filename ?? __tomjs_fileURLToPath(import.meta.url);`,
  '',
].join('\n');

/** The Vite build watchers created in dev mode, kept alive until exit. */
const watchers: Array<{ close: () => Promise<void> | void }> = [];

function getNodeExternal(externals: Array<string | RegExp> = []) {
  const modules = builtinModules.filter(
    x => !/^_|^(?:internal|v8|node-inspect|fsevents)\/|\//.test(x),
  );
  return [
    ...new Set(modules.concat(modules.map(s => `node:${s}`)).concat(externals.map(String))),
  ];
}

function arrayable<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * Convert an `ExtensionOptions` into a Vite `InlineConfig` that compiles the
 * consumer's vscode extension with Vite itself (replacing the old tsdown build).
 */
export function toViteConfig(
  opt: ExtensionOptions,
  isServe: boolean,
  plugins: Plugin[] = [],
): InlineConfig {
  const {
    entry,
    format,
    outDir,
    external,
    clean,
    treeshake,
    target,
    sourcemap,
    minify,
    watchFiles: _watchFiles,
    ignoreWatch,
    onSuccess: _onSuccess,
    env,
    logLevel,
    ...rest
  } = opt as unknown as Record<string, any>;

  const isEsm = format !== 'cjs';

  const define: Record<string, string> = {};
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      define[`process.env.${key}`] = JSON.stringify(value);
    }
  }

  return {
    ...rest,
    configFile: false,
    logLevel: logLevel ?? 'silent',
    resolve: {
      ...(rest.resolve || {}),
      conditions: [...new Set([...(rest.resolve?.conditions || []), 'node'])],
    },
    define: {
      ...define,
      ...(rest.define || {}),
    },
    plugins: [
      ...plugins,
      ...(rest.plugins || []),
    ],
    build: {
      outDir,
      emptyOutDir: clean ?? true,
      copyPublicDir: false,
      sourcemap: sourcemap ?? false,
      minify: minify ?? false,
      target: target ?? (isEsm ? 'node20' : ['es2019', 'node14']),
      lib: {
        entry,
        formats: [isEsm ? 'es' : 'cjs'],
        fileName: () => '[name].js',
      },
      rolldownOptions: {
        external: getNodeExternal(external ?? ['vscode']),
        treeshake: treeshake ?? false,
        output: isEsm ? { banner: ESM_SHIMS } : undefined,
      },
      watch: isServe
        ? { exclude: [...DEFAULT_IGNORE_WATCH, ...(arrayable(ignoreWatch) || [])] }
        : undefined,
    },
  };
}

function closeWatchers() {
  for (const watcher of watchers) {
    try {
      watcher.close();
    }
    catch {
      // ignore close errors during shutdown
    }
  }
}

let hookedProcessExit = false;
function hookProcessExit() {
  if (hookedProcessExit) {
    return;
  }
  hookedProcessExit = true;
  process.once('exit', closeWatchers);
}

/** Compile the consumer's vscode extension in dev (watch) mode. */
export async function runExtensionServe(options: ExtensionOptions, plugins: Plugin[] = []) {
  const { onSuccess: _onSuccess } = options;

  logger.info('extension build start');

  let buildFlag = false;
  const onSuccess = async () => {
    if (_onSuccess) {
      if (typeof _onSuccess === 'string') {
        await execa(_onSuccess);
      }
      else if (typeof _onSuccess === 'function') {
        await _onSuccess(undefined, undefined);
      }
    }

    if (!buildFlag) {
      buildFlag = true;
      logger.info('extension build success');
    }
  };

  const config = toViteConfig(options, true, plugins);
  config.plugins.push({
    name: `${PLUGIN_NAME}:extension`,
    apply: 'build',
    writeBundle() {
      return onSuccess();
    },
  });

  const watcher = await viteBuild(config);
  watchers.push(watcher as { close: () => Promise<void> | void });
  hookProcessExit();
}

/** Compile the consumer's vscode extension for production. */
export async function runExtensionBuild(options: ExtensionOptions, plugins: Plugin[] = []) {
  const { onSuccess: _onSuccess } = options;

  logger.info('extension build start');

  await viteBuild(toViteConfig(options, false, plugins));

  if (_onSuccess) {
    if (typeof _onSuccess === 'string') {
      await execa(_onSuccess);
    }
    else if (typeof _onSuccess === 'function') {
      await _onSuccess(undefined, undefined);
    }
  }

  logger.info(colors.green('extension build success'));
}
