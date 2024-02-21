import {UrlPath} from "./brandedPath.js";
import type {Config, Page} from "./config.js";

export type PageLink =
  | {prev: undefined; next: Page} // first page
  | {prev: Page; next: Page} // middle page
  | {prev: Page; next: undefined}; // last page

// Pager links in the footer are computed once for a given navigation.
const linkCache = new WeakMap<Config["pages"], Map<UrlPath, PageLink>>();

/**
 * Strip URL query string and hash fragment.
 */
export function normalizePath(path: UrlPath): UrlPath {
  return path.replace(/[?#].*$/, "");
}

export function findLink(path: UrlPath, options: Pick<Config, "pages" | "title"> = {pages: []}): PageLink | undefined {
  const {pages, title} = options;
  let links = linkCache.get(pages);
  if (!links) {
    links = new Map<UrlPath, PageLink>();
    let prev: Page | undefined;
    for (const page of walk(pages, title)) {
      const path = normalizePath(page.path);
      if (links.has(path)) {
        console.warn(`ignoring duplicate page: ${page.path}`);
      } else {
        if (prev) {
          links.set(path, {prev, next: undefined});
          links.get(normalizePath(prev.path))!.next = page;
        } else {
          links.set(path, {prev: undefined, next: undefined as unknown as Page}); // next set lazily
        }
        prev = page;
      }
    }
    if (links.size === 1) links.clear(); // no links if only one page
    linkCache.set(pages, links);
  }
  return links.get(path);
}

// Walks the unique pages in the site so as to avoid creating cycles. Implicitly
// adds a link at the beginning to the home page (/index).
function* walk(pages: Config["pages"], title = "Home", visited = new Set<UrlPath>()): Generator<Page> {
  if (!visited.has(UrlPath("/index"))) yield (visited.add(UrlPath("/index")), {name: title, path: UrlPath("/index")});
  for (const page of pages) {
    if ("pages" in page) yield* walk(page.pages, title, visited);
    else if (!visited.has(page.path)) yield (visited.add(page.path), page);
  }
}
