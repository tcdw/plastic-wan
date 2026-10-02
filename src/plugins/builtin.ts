import alarm from './alarm/index.ts';
import image from './image/index.ts';
import type { AgentPlugin } from './plugin.ts';
import webFetch from './web-fetch/index.ts';

/**
 * Built-in agent plugins. Every composition root loads this same list. The
 * image plugin contributes nothing unless the host wired an image bridge and
 * generation is enabled, so runtimes without image configuration are
 * unaffected.
 */
export const BUILTIN_PLUGINS: readonly AgentPlugin[] = [webFetch, image, alarm];
