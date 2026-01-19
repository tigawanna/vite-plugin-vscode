import type { InlineConfig as TsdownOptions } from 'tsdown';
import type { PluginOption, ResolvedConfig, UserConfig } from 'vite';
import type { ExtensionOptions, PluginOptions, WebviewOption } from './types';
import fs from 'node:fs';
import path from 'node:path';
import { cwd } from 'node:process';
import { readFileSync, readJsonSync } from '@tomjs/node';
import { execa } from 'execa';
import merge from 'lodash.merge';
import { parse as htmlParser } from 'node-html-parser';
import colors from 'picocolors';
import { build as tsdownBuild } from 'tsdown';
import { ORG_NAME, RESOLVED_VIRTUAL_MODULE_ID, VIRTUAL_MODULE_ID } from './constants';
import { logger } from './logger';
import { resolveServerUrl } from './utils';

export * from './types';

const isDev = process.env.NODE_ENV === 'development';

function getPkg() {
  const pkgFile = path.resolve(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgFile)) {
    throw new Error('Main file is not specified, and no package.json found');
  }

  const pkg = readJsonSync(pkgFile);
  if (!pkg.main) {
    throw new Error('Main file is not specified, please check package.json');
  }

  return pkg;
}

function preMergeOptions(options?: PluginOptions): PluginOptions {
  const pkg = getPkg();
  const format = pkg.type === 'module' ? 'esm' : 'cjs';

  const opts: PluginOptions = merge(
    {
      webview: true,
      recommended: true,
      extension: {
        entry: 'extension/index.ts',
        outDir: 'dist-extension',
        target: format === 'esm' ? ['node20'] : ['es2019', 'node14'],
        format,
        shims: true,
        clean: true,
        dts: false,
        treeshake: !isDev,
        publint: false,
        // ignore tsdown.config.ts from project
        config: false,
        fixedExtension: false,
        external: ['vscode'],
      } as ExtensionOptions,
    } as PluginOptions,
    options,
  );

  const opt = opts.extension || {};

  if (isDev) {
    opt.sourcemap = opt.sourcemap ?? true;
  }
  else {
    opt.minify ??= true;
    opt.clean ??= true;
  }
  if (typeof opt.external !== 'function') {
    opt.external = (['vscode'] as (string | RegExp)[]).concat(opt.external ?? []);
    opt.external = [...new Set(opt.external)];
  }
  else {
    const fn = opt.external;
    opt.external = function (id, parentId, isResolved) {
      if (id === 'vscode') {
        return true;
      }
      return fn(id, parentId, isResolved);
    };
  }

  if (!isDev && !opt.skipNodeModulesBundle && !opt.noExternal) {
    opt.noExternal = Object.keys(pkg.dependencies || {}).concat(
      Object.keys(pkg.peerDependencies || {}),
    );
  }

  opts.extension = opt;

  return opts;
}

function genProdWebviewCode(cache: Record<string, string>, webview?: WebviewOption) {
  webview = Object.assign({}, webview);

  function handleHtmlCode(html: string) {
    const root = htmlParser(html);
    const head = root.querySelector('head')!;
    if (!head) {
      root?.insertAdjacentHTML('beforeend', '<head></head>');
    }

    const csp
      = webview?.csp
        || `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src {{cspSource}} 'unsafe-inline'; script-src 'nonce-{{nonce}}' 'unsafe-eval';">`;
    head.insertAdjacentHTML('afterbegin', csp);

    if (csp && csp.includes('{{nonce}}')) {
      const tags = {
        script: 'src',
        link: 'href',
      };

      Object.keys(tags).forEach((tag) => {
        const elements = root.querySelectorAll(tag);
        elements.forEach((element) => {
          const attr = element.getAttribute(tags[tag]);
          if (attr) {
            element.setAttribute(tags[tag], `{{baseUri}}${attr}`);
          }

          element.setAttribute('nonce', '{{nonce}}');
        });
      });
    }

    return root.removeWhitespace().toString();
  }

  const cacheCode = /* js */ `const htmlCode = {
    ${Object.keys(cache)
      .map(s => `'${s}': \`${handleHtmlCode(cache[s])}\`,`)
      .join('\n')}
  };`;

  const code = /* js */ `import { Uri } from 'vscode';

${cacheCode}

function uuid() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getWebviewHtml(options){
  const { webview, context, inputName, injectCode } = options || {};
  const nonce = uuid();
  const baseUri = webview.asWebviewUri(Uri.joinPath(context.extensionUri, (process.env.VITE_WEBVIEW_DIST || 'dist')));
  let html = htmlCode[inputName || 'index'] || '';
  if (injectCode) {
    html = html.replace('<head>', '<head>'+ injectCode);
  }

  return html.replaceAll('{{cspSource}}', webview.cspSource).replaceAll('{{nonce}}', nonce).replaceAll('{{baseUri}}', baseUri);
}

export default getWebviewHtml;
`;
  return code;
}

export function useVSCodePlugin(options?: PluginOptions): PluginOption {
  const opts = preMergeOptions(options);

  const handleConfig = (config: UserConfig, isRolldown: boolean): UserConfig => {
    let outDir = config?.build?.outDir || 'dist';
    opts.extension ??= {};
    if (opts.recommended) {
      opts.extension.outDir = path.resolve(outDir, 'extension');
      outDir = path.resolve(outDir, 'webview');
    }

    const outputOptions: Record<string, any> = {};
    const buildConfig = config.build || {};

    // Compatible with rolldown
    const optKey = isRolldown ? 'rolldownOptions' : (['rolldownOptions', 'rollupOptions'].find(s => buildConfig[s]) || 'rollupOptions');

    const outputDefault: Record<string, any> = {};
    const inputs = buildConfig[optKey]?.input;
    if (Array.isArray(inputs) && inputs.length === 1) {
      if (isRolldown) {
        outputDefault.codeSplitting = false;
      }
      else {
        outputDefault.inlineDynamicImports = true;
      }
    }
    let output = buildConfig[optKey]?.output || {};
    if (Array.isArray(output)) {
      output.map(s => Object.assign({}, outputDefault, s));
    }
    else {
      output = Object.assign({}, outputDefault, output);
    }

    outputOptions[optKey] = Object.assign(outputOptions[optKey] || {}, isRolldown ? {} : {}, { output });

    return {
      build: {
        outDir,
        sourcemap: isDev ? true : config?.build?.sourcemap,
        ...outputOptions,
      },
    };
  };

  let devWebviewClientCode: string;
  let devWebviewVirtualCode: string;

  let resolvedConfig: ResolvedConfig;
  // multiple entry index.html
  const prodHtmlCache: Record<string, string> = {};

  let devtoolsFlag = false;

  return [
    {
      name: '@tomjs:vscode',
      apply: 'serve',
      config(config) {
        return handleConfig(config, this && 'rolldownVersion' in this.meta);
      },
      configResolved(config) {
        resolvedConfig = config;

        if (opts.webview) {
          devWebviewClientCode = readFileSync(path.join(__dirname, 'client.iife.js'));
          devWebviewVirtualCode = readFileSync(path.join(__dirname, 'webview.js'));
        }
      },
      configureServer(server) {
        if (!server || !server.httpServer) {
          return;
        }

        server.httpServer?.once('listening', async () => {
          const env = {
            NODE_ENV: server.config.mode || 'development',
            VITE_DEV_SERVER_URL: resolveServerUrl(server),
          };

          logger.info('extension build start');

          const webview = opts?.webview as WebviewOption;

          const { onSuccess: _onSuccess, ignoreWatch, logLevel, watchFiles, ...tsdownOptions } = opts.extension || {};
          const entryDir = path.dirname(tsdownOptions.entry);

          let buildFlag = false;

          await tsdownBuild(
            merge(tsdownOptions, {
              watch: watchFiles ?? (opts.recommended ? ['extension'] : true),
              ignoreWatch: (['.history', '.temp', '.tmp', '.cache', 'dist'] as (string | RegExp)[]).concat(Array.isArray(ignoreWatch) ? ignoreWatch : []),
              env,
              logLevel: logLevel ?? 'silent',
              plugins: !webview
                ? []
                : [
                    {
                      name: `${ORG_NAME}:vscode:inject`,
                      resolveId(id) {
                        if (id === VIRTUAL_MODULE_ID) {
                          return RESOLVED_VIRTUAL_MODULE_ID;
                        }
                      },
                      load(id) {
                        if (id === RESOLVED_VIRTUAL_MODULE_ID)
                          return devWebviewVirtualCode;
                      },
                      watchChange(id, e) {
                        let event = '';
                        if (e.event === 'update') {
                          event = colors.green(e.event);
                        }
                        else if (e.event === 'delete') {
                          event = colors.red(e.event);
                        }
                        else {
                          event = colors.blue(e.event);
                        }
                        logger.info(`${event} ${colors.dim(path.relative(entryDir, id))}`);
                      },
                    },
                  ],
              async onSuccess(config, signal) {
                if (_onSuccess) {
                  if (typeof _onSuccess === 'string') {
                    await execa(_onSuccess);
                  }
                  else if (typeof _onSuccess === 'function') {
                    await _onSuccess(config, signal);
                  }
                }

                if (!buildFlag) {
                  buildFlag = true;
                  logger.info('extension build success');
                }
              },
              buildOptions: {},
            } as TsdownOptions),
          );
        });
      },
      transformIndexHtml(html) {
        if (!opts.webview) {
          return html;
        }

        const devtools = opts.devtools;
        if (devtools) {
          let port: number | undefined;
          if (typeof devtools === 'number') {
            port = devtools;
          }
          else if (devtools === true) {
            if (resolvedConfig.plugins.find(s => ['vite:vue', 'vite:vue2'].includes(s.name))) {
              port = 8098;
            }
            else if (resolvedConfig.plugins.find(s => ['vite:react-refresh', 'vite:react-swc'].includes(s.name))) {
              port = 8097;
            }
          }

          if (port) {
            html = html.replace(/<head>/i, `<head><script src="http://localhost:${port}"></script>`);
          }
          else if (!devtoolsFlag) {
            devtoolsFlag = true;
            logger.warn('Only support react-devtools and vue-devtools!');
          }
        }

        return html.replace(/<head>/i, `<head><script>${devWebviewClientCode}</script>`);
      },
    },
    {
      name: '@tomjs:vscode',
      apply: 'build',
      enforce: 'post',
      config(config) {
        return handleConfig(config, this && 'rolldownVersion' in this.meta);
      },
      configResolved(config) {
        resolvedConfig = config;
      },
      transformIndexHtml(html, ctx) {
        if (!opts.webview) {
          return html;
        }

        prodHtmlCache[ctx.chunk?.name as string] = html;
        return html;
      },
      closeBundle() {
        let webviewVirtualCode: string;

        const webview = opts?.webview as WebviewOption;
        if (webview) {
          webviewVirtualCode = genProdWebviewCode(prodHtmlCache, webview);
        }

        let outDir = resolvedConfig.build.outDir.replace(cwd(), '').replaceAll('\\', '/');
        if (outDir.startsWith('/')) {
          outDir = outDir.substring(1);
        }
        const env = {
          NODE_ENV: resolvedConfig.mode || 'production',
          VITE_WEBVIEW_DIST: outDir,
        };

        logger.info('extension build start');

        const { onSuccess: _onSuccess, logLevel, ...tsupOptions } = opts.extension || {};

        tsdownBuild(
          merge(tsupOptions, {
            env,
            logLevel: logLevel ?? 'silent',
            plugins: !webview
              ? []
              : [
                  {
                    name: `${ORG_NAME}:vscode:inject`,
                    resolveId(id) {
                      if (id === VIRTUAL_MODULE_ID) {
                        return RESOLVED_VIRTUAL_MODULE_ID;
                      }
                    },
                    load(id) {
                      if (id === RESOLVED_VIRTUAL_MODULE_ID)
                        return webviewVirtualCode;
                    },
                  },
                ],
            async onSuccess(config, signal) {
              if (_onSuccess) {
                if (typeof _onSuccess === 'string') {
                  await execa(_onSuccess);
                }
                else if (typeof _onSuccess === 'function') {
                  await _onSuccess(config, signal);
                }
              }
              logger.info('extension build success');
            },
          } as TsdownOptions),
        );
      },
    },
  ];
}

export default useVSCodePlugin;
