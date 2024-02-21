import {createHash} from "node:crypto";
import type {FSWatcher, WatchEventType} from "node:fs";
import {createServer} from "node:http";
import type {IncomingMessage, RequestListener, Server, ServerResponse} from "node:http";
import {fileURLToPath} from "node:url";
import {difference} from "d3-array";
import openBrowser from "open";
import send from "send";
import {type WebSocket, WebSocketServer} from "ws";
import {version} from "../package.json";
import {access, constants, readFile, stat, watch} from "./brandedFs.js";
import {
  FilePath,
  UrlPath,
  fileBasename,
  fileDirname,
  fileExtname,
  fileJoin,
  fileNormalize,
  filePathToUrlPath,
  unFilePath,
  unUrlPath,
  urlBasename,
  urlDirname,
  urlJoin,
  urlNormalize,
  urlPathToFilePath
} from "./brandedPath.js";
import type {Config} from "./config.js";
import {mergeStyle} from "./config.js";
import {Loader} from "./dataloader.js";
import {HttpError, isEnoent, isHttpError, isSystemError} from "./error.js";
import {getClientPath} from "./files.js";
import {FileWatchers} from "./fileWatchers.js";
import {createImportResolver, rewriteModule} from "./javascript/imports.js";
import {getImplicitSpecifiers, getImplicitStylesheets} from "./libraries.js";
import {diffMarkdown, parseMarkdown} from "./markdown.js";
import type {ParseResult} from "./markdown.js";
import {renderPreview, resolveStylesheet} from "./render.js";
import {bundleStyles, rollupClient} from "./rollup.js";
import {searchIndex} from "./search.js";
import {Telemetry} from "./telemetry.js";
import {bold, faint, green, link, red} from "./tty.js";
import {relativeUrl} from "./url.js";

const publicRoot = fileJoin(fileDirname(FilePath(fileURLToPath(import.meta.url))), "..", "public");

export interface PreviewOptions {
  config: Config;
  hostname: string;
  open?: boolean;
  port?: number;
  verbose?: boolean;
}

export async function preview(options: PreviewOptions): Promise<PreviewServer> {
  return PreviewServer.start(options);
}

export class PreviewServer {
  private readonly _config: Config;
  private readonly _server: ReturnType<typeof createServer>;
  private readonly _socketServer: WebSocketServer;
  private readonly _verbose: boolean;

  private constructor({config, server, verbose}: {config: Config; server: Server; verbose: boolean}) {
    this._config = config;
    this._verbose = verbose;
    this._server = server;
    this._server.on("request", this._handleRequest);
    this._socketServer = new WebSocketServer({server: this._server});
    this._socketServer.on("connection", this._handleConnection);
  }

  static async start({verbose = true, hostname, port, open, ...options}: PreviewOptions) {
    Telemetry.record({event: "preview", step: "start"});
    const server = createServer();
    if (port === undefined) {
      for (port = 3000; true; ++port) {
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, hostname, resolve);
          });
          break;
        } catch (error) {
          if (!isSystemError(error) || error.code !== "EADDRINUSE") throw error;
        }
      }
    } else {
      await new Promise<void>((resolve) => server.listen(port, hostname, resolve));
    }
    const url = `http://${hostname}:${port}/`;
    if (verbose) {
      console.log(`${green(bold("Observable Framework"))} ${faint(`v${version}`)}`);
      console.log(`${faint("↳")} ${link(url)}`);
      console.log("");
    }
    if (open) openBrowser(url);
    return new PreviewServer({server, verbose, ...options});
  }

  _handleRequest: RequestListener = async (req, res) => {
    const config = this._config;
    const root = config.root;
    if (this._verbose) console.log(faint(req.method!), req.url);
    try {
      const url = new URL(req.url!, "http://localhost");
      let pathname = UrlPath(decodeURIComponent(url.pathname));
      let match: RegExpExecArray | null;
      if (pathname === UrlPath("/_observablehq/runtime.js")) {
        const root = fileJoin(fileURLToPath(import.meta.resolve("@observablehq/runtime")), "../../");
        send(req, "/dist/runtime.js", {root: unFilePath(root)}).pipe(res);
      } else if (pathname.startsWith("/_observablehq/stdlib.js")) {
        end(req, res, await rollupClient(getClientPath(FilePath("./src/client/stdlib.js"))), "text/javascript");
      } else if (pathname.startsWith("/_observablehq/stdlib/")) {
        const path = getClientPath(FilePath("./src/client/" + pathname.slice("/_observablehq/".length)));
        if (pathname.endsWith(".js")) {
          end(req, res, await rollupClient(path), "text/javascript");
        } else if (pathname.endsWith(".css")) {
          end(req, res, await bundleStyles({path}), "text/css");
        } else {
          throw new HttpError(`Not found: ${pathname}`, 404);
        }
      } else if (pathname === UrlPath("/_observablehq/client.js")) {
        end(req, res, await rollupClient(getClientPath(FilePath("./src/client/preview.js"))), "text/javascript");
      } else if (pathname === UrlPath("/_observablehq/search.js")) {
        end(req, res, await rollupClient(getClientPath(FilePath("./src/client/search.js"))), "text/javascript");
      } else if (pathname === UrlPath("/_observablehq/minisearch.json")) {
        end(req, res, await searchIndex(config), "application/json");
      } else if ((match = /^\/_observablehq\/theme-(?<theme>[\w-]+(,[\w-]+)*)?\.css$/.exec(unUrlPath(pathname)))) {
        end(req, res, await bundleStyles({theme: match.groups!.theme?.split(",") ?? []}), "text/css");
      } else if (pathname.startsWith("/_observablehq/")) {
        send(req, unUrlPath(pathname).slice("/_observablehq".length), {root: unFilePath(publicRoot)}).pipe(res);
      } else if (pathname.startsWith("/_import/")) {
        const filepath = fileJoin(root, urlPathToFilePath(pathname));
        try {
          if (pathname.endsWith(".css")) {
            await access(filepath, constants.R_OK);
            end(req, res, await bundleStyles({path: filepath}), "text/css");
            return;
          } else if (pathname.endsWith(".js")) {
            const input = await readFile(filepath, "utf-8");
            const output = await rewriteModule(input, filepath, createImportResolver(root));
            end(req, res, output, "text/javascript");
            return;
          }
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
        throw new HttpError(`Not found: ${pathname}`, 404);
      } else if (pathname.startsWith("/_file/")) {
        const path = urlPathToFilePath(pathname.slice("/_file".length));
        const filepath = fileJoin(root, path);
        try {
          await access(filepath, constants.R_OK);
          send(req, unUrlPath(pathname.slice("/_file".length)), {root: unFilePath(root)}).pipe(res);
          return;
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }

        // Look for a data loader for this file.
        const loader = Loader.find(root, path);
        if (loader) {
          try {
            send(req, unFilePath(await loader.load()), {root: unFilePath(root)}).pipe(res);
            return;
          } catch (error) {
            if (!isEnoent(error)) throw error;
          }
        }
        throw new HttpError(`Not found: ${pathname}`, 404);
      } else {
        if ((pathname = urlNormalize(pathname)).startsWith("..")) throw new Error("Invalid path: " + pathname);
        let path = fileJoin(root, urlPathToFilePath(pathname));

        // If this path is for /index, redirect to the parent directory for a
        // tidy path. (This must be done before implicitly adding /index below!)
        // Respect precedence of dir/index.md over dir.md in choosing between
        // dir/ and dir!
        if (fileBasename(path, ".html") === "index") {
          try {
            await stat(fileJoin(fileDirname(path), "index.md"));
            res.writeHead(302, {Location: urlJoin(urlDirname(pathname), "/") + url.search});
            res.end();
            return;
          } catch (error) {
            if (!isEnoent(error)) throw error;
            res.writeHead(302, {Location: urlDirname(pathname) + url.search});
            res.end();
            return;
          }
        }

        // If this path resolves to a directory, then add an implicit /index to
        // the end of the path, assuming that the corresponding index.md exists.
        try {
          if ((await stat(path)).isDirectory() && (await stat(fileJoin(path, "index.md"))).isFile()) {
            if (!pathname.endsWith("/")) {
              res.writeHead(302, {Location: pathname + "/" + url.search});
              res.end();
              return;
            }
            pathname = urlJoin(pathname, "index");
            path = fileJoin(path, "index");
          }
        } catch (error) {
          if (!isEnoent(error)) throw error; // internal error
        }

        // If this path ends with .html, then redirect to drop the .html. TODO:
        // Check for the existence of the .md file first.
        if (fileExtname(path) === ".html") {
          res.writeHead(302, {Location: urlJoin(urlDirname(pathname), urlBasename(pathname, ".html")) + url.search});
          res.end();
          return;
        }

        // Otherwise, serve the corresponding Markdown file, if it exists.
        // Anything else should 404; static files should be matched above.
        try {
          const {html} = await renderPreview(FilePath(path + ".md"), {path: pathname, ...config});
          end(req, res, html, "text/html");
        } catch (error) {
          if (!isEnoent(error)) throw error; // internal error
          throw new HttpError("Not found", 404);
        }
      }
    } catch (error) {
      if (isHttpError(error)) {
        res.statusCode = error.statusCode;
      } else {
        res.statusCode = 500;
        console.error(error);
      }
      if (req.method === "GET" && res.statusCode === 404) {
        try {
          const {html} = await renderPreview(fileJoin(root, "404.md"), {path: UrlPath("/404"), ...config});
          end(req, res, html, "text/html");
          return;
        } catch {
          // ignore secondary error (e.g., no 404.md); show the original 404
        }
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(error instanceof Error ? error.message : "Oops, an error occurred");
    }
  };

  _handleConnection = async (socket: WebSocket, req: IncomingMessage) => {
    if (req.url === "/_observablehq") {
      handleWatch(socket, req, this._config);
    } else {
      socket.close();
    }
  };

  get server(): PreviewServer["_server"] {
    return this._server;
  }
}

// Like send, but for in-memory dynamic content.
function end(req: IncomingMessage, res: ServerResponse, content: string, type: string): void {
  const etag = `"${createHash("sha256").update(content).digest("base64")}"`;
  const date = new Date().toUTCString();
  res.setHeader("Content-Type", `${type}; charset=utf-8`);
  res.setHeader("Date", date);
  res.setHeader("Last-Modified", date);
  res.setHeader("ETag", etag);
  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
  } else if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(content);
  }
}

function getWatchPaths(parseResult: ParseResult): FilePath[] {
  const paths: FilePath[] = [];
  const {files, imports} = parseResult;
  for (const f of files) paths.push(urlPathToFilePath(f.name));
  for (const i of imports) paths.push(urlPathToFilePath(i.name));
  return paths;
}

export function getPreviewStylesheet(path: UrlPath, data: ParseResult["data"], style: Config["style"]): UrlPath | null {
  const filePath = urlPathToFilePath(path);
  try {
    style = mergeStyle(filePath, data?.style, data?.theme, style);
  } catch (error) {
    console.error(red(String(error)));
    return relativeUrl(path, UrlPath("/_observablehq/theme-.css"));
  }
  return !style
    ? null
    : "path" in style
    ? relativeUrl(path, UrlPath(`/_import/${style.path}`))
    : relativeUrl(path, UrlPath(`/_observablehq/theme-${style.theme.join(",")}.css`));
}

function handleWatch(socket: WebSocket, req: IncomingMessage, {root, style: defaultStyle}: Config) {
  let path: FilePath | null = null;
  let current: ParseResult | null = null;
  let stylesheets: Set<UrlPath> | null = null;
  let markdownWatcher: FSWatcher | null = null;
  let attachmentWatcher: FileWatchers | null = null;
  let emptyTimeout: ReturnType<typeof setTimeout> | null = null;

  console.log(faint("socket open"), req.url);

  async function getStylesheets({cells, data}: ParseResult): Promise<Set<UrlPath>> {
    const inputs = new Set<string>();
    const urlPath = filePathToUrlPath(path!);
    for (const cell of cells) cell.inputs?.forEach(inputs.add, inputs);
    const stylesheets = await getImplicitStylesheets(getImplicitSpecifiers(inputs));
    const style = getPreviewStylesheet(urlPath, data, defaultStyle);
    if (style) stylesheets.add(style);
    return new Set(Array.from(stylesheets, (href) => resolveStylesheet(urlPath, href)));
  }

  function refreshAttachment(name: FilePath) {
    const urlName = filePathToUrlPath(name);
    const {cells} = current!;
    if (cells.some((cell) => cell.imports?.some((i) => i.name === urlName))) {
      watcher("change"); // trigger re-compilation of JavaScript to get new import hashes
    } else {
      const affectedCells = cells.filter((cell) => cell.files?.some((f) => f.name === urlName));
      if (affectedCells.length > 0) {
        send({type: "refresh", cellIds: affectedCells.map((cell) => cell.id)});
      }
    }
  }

  async function watcher(event: WatchEventType, force = false) {
    if (!path || !current) throw new Error("not initialized");
    switch (event) {
      case "rename": {
        markdownWatcher?.close();
        try {
          markdownWatcher = watch(fileJoin(root, path), (event) => watcher(event));
        } catch (error) {
          if (!isEnoent(error)) throw error;
          console.error(`file no longer exists: ${path}`);
          socket.terminate();
          return;
        }
        watcher("change");
        break;
      }
      case "change": {
        const updated = await parseMarkdown(fileJoin(root, path), {root, path: filePathToUrlPath(path)});
        // delay to avoid a possibly-empty file
        if (!force && updated.html === "") {
          if (!emptyTimeout) {
            emptyTimeout = setTimeout(() => {
              emptyTimeout = null;
              watcher("change", true);
            }, 150);
          }
          break;
        } else if (emptyTimeout) {
          clearTimeout(emptyTimeout);
          emptyTimeout = null;
        }
        if (current.hash === updated.hash) break;
        const updatedStylesheets = await getStylesheets(updated);
        for (const href of difference(stylesheets, updatedStylesheets)) send({type: "remove-stylesheet", href});
        for (const href of difference(updatedStylesheets, stylesheets)) send({type: "add-stylesheet", href});
        stylesheets = updatedStylesheets;
        const diff = diffMarkdown(current, updated);
        send({type: "update", diff, previousHash: current.hash, updatedHash: updated.hash});
        current = updated;
        attachmentWatcher?.close();
        attachmentWatcher = await FileWatchers.of(root, path, getWatchPaths(updated), refreshAttachment);
        break;
      }
    }
  }

  async function hello({path: initialPath, hash: initialHash}: {path: UrlPath; hash: string}): Promise<void> {
    if (markdownWatcher || attachmentWatcher) throw new Error("already watching");
    path = urlPathToFilePath(initialPath);
    if (!(path = fileNormalize(path)).startsWith("/")) throw new Error("Invalid path: " + initialPath);
    if (path.endsWith("/")) path = FilePath(path + "index");
    path = FilePath(path + ".md");
    current = await parseMarkdown(fileJoin(root, path), {root, path: filePathToUrlPath(path)});
    if (current.hash !== initialHash) return void send({type: "reload"});
    stylesheets = await getStylesheets(current);
    attachmentWatcher = await FileWatchers.of(root, path, getWatchPaths(current), refreshAttachment);
    markdownWatcher = watch(fileJoin(root, path), (event) => watcher(event));
  }

  socket.on("message", async (data) => {
    try {
      const message = JSON.parse(String(data));
      console.log(faint("↑"), message);
      switch (message.type) {
        case "hello": {
          await hello(message);
          break;
        }
      }
    } catch (error) {
      console.error("Protocol error", error);
      socket.terminate();
    }
  });

  socket.on("error", (error) => {
    console.error("error", error);
  });

  socket.on("close", () => {
    if (attachmentWatcher) {
      attachmentWatcher.close();
      attachmentWatcher = null;
    }
    if (markdownWatcher) {
      markdownWatcher.close();
      markdownWatcher = null;
    }
    console.log(faint("socket close"), req.url);
  });

  function send(message) {
    console.log(faint("↓"), message);
    socket.send(JSON.stringify(message));
  }
}
