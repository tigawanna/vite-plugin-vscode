import type { UserConfig as ViteOptions } from 'vite';

type Arrayable<T> = T | T[];

/**
 * vscode extension options. The extension code is now compiled with
 * [vite](https://vite.dev/) itself (replacing the previous tsdown build), so this
 * interface inherits every top-level [Vite UserConfig](https://vite.dev/config/) option.
 *
 * The following fields are managed by the plugin and therefore omitted from the
 * inheritance: `configFile`, `base`, `root` and `build`.
 */
export interface ExtensionOptions
  extends Omit<ViteOptions, 'configFile' | 'base' | 'root' | 'build'> {
  /**
   * The extension entry file.
   * @default "extension/index.ts"
   */
  entry?: string | string[] | Record<string, string>;
  /**
   * The bundle format. If not specified, it will use the `type` field from `package.json`.
   */
  format?: 'cjs' | 'esm';
  /**
   * The output directory for the extension files. Default is `dist-extension`.
   * @default "dist-extension"
   */
  outDir?: string;
  /**
   * Don't bundle these modules. `vscode` and Node.js built-ins are always excluded.
   */
  external?: Arrayable<string | RegExp> | ((id: string, parentId?: string, isResolved?: boolean) => boolean | void);
  /**
   * Empty the output directory before building.
   * @default true
   */
  clean?: boolean;
  /**
   * Enable/disable tree-shaking.
   * @default true in production, false in development
   */
  treeshake?: boolean;
  /**
   * The build target, passed to Vite's `build.target`.
   * @default 'node20' for esm, ['es2019', 'node14'] for cjs
   */
  target?: string | string[] | false;
  /**
   * Whether to generate sourcemaps.
   * @default true in development, false in production
   */
  sourcemap?: boolean | 'inline' | 'hidden';
  /**
   * Minify the output. `true` is an alias for `'oxc'`.
   * @default false in development, true in production
   */
  minify?: boolean | 'oxc' | 'terser' | 'esbuild';
  /**
   * Additional files or folders to watch (dev mode). With Vite the module
   * dependency graph is always watched, so this is only needed for files
   * outside the graph.
   */
  watchFiles?: string | string[];
  /**
   * Files or folders to ignore while watching.
   * @default ['.history', '.temp', '.tmp', '.cache', 'dist']
   */
  ignoreWatch?: Arrayable<string | RegExp>;
  /**
   * A shell command or callback to run after every successful build.
   */
  onSuccess?: string | ((config?: unknown, signal?: unknown) => void | Promise<void>);
  /**
   * Environment variables inlined into the bundle via Vite's `define`.
   * @internal
   */
  env?: Record<string, string>;
}

/**
 * vscode webview options.
 */
export interface WebviewOption {
  /**
   * The CSP meta for the webview. Default is `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src {{cspSource}} 'unsafe-inline'; script-src 'nonce-{{nonce}}' 'unsafe-eval';">`
   */
  csp?: string;
}

/**
 * vite plugin options.
 */
export interface PluginOptions {
  /**
   * Recommended switch. Default is true.
   * if true, will have the following default behavior:
   * - will change the extension/webview outDir to be parallel outDir;
   * - if vite build.outDir is 'dist', will change extension/webview to 'dist/extension' and 'dist/webview'
   * @default true
   */
  recommended?: boolean;
  /**
   * During development, inject code into both `vscode extension code` and `web page` code to support `HMR`;
   *
   * During production builds, inject the final generated `index.html` code into the `vscode extension code` to minimize manual effort.
   *
   * @example
   * extension file
   * ```ts
   *import {getWebviewHtml} from 'virtual:vscode';
   *
   *function setupHtml(webview: Webview, context: ExtensionContext) {
   *  return getWebviewHtml({serverUrl:process.env.VITE_DEV_SERVER_URL, webview, context});
   *}
   * ```
   */
  webview?: boolean | string | WebviewOption;
  /**
   * extension vite config.
   */
  extension?: ExtensionOptions;
  /**
   * Whether to enable devtools. Inject `<script src="http://localhost:<devtools-port>"></script>` into webview client . Default is true.
   *  - true:
   *    - react: inject `<script src="http://localhost:8097"></script>`
   *    - vue: inject `<script src="http://localhost:8098"></script>`
   *  - `number`: custom port
   * @default false
   */
  devtools?: boolean | number;
}
