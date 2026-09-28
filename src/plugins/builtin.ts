import type { AgentPlugin } from './plugin.ts';
import alarm from './alarm/index.ts';
import webFetch from './web-fetch/index.ts';

/** Built-in agent plugins. Every composition root loads this same list. */
export const BUILTIN_PLUGINS: readonly AgentPlugin[] = [webFetch, alarm];
