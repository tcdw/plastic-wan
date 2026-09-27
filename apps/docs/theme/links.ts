import { routePathToMdPath, withBase, withSiteOrigin } from '@rspress/core/runtime';

export function pageLink(path: string): string {
  return import.meta.env.SSG_MD ? withSiteOrigin(routePathToMdPath(path)) : withBase(path);
}
