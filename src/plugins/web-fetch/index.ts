import { join } from 'node:path';
import { capability } from '../../capabilities/execute-tool.ts';
import { definePlugin } from '../plugin.ts';
import { createWebFetchTool } from './web-fetch.ts';

export default definePlugin({
  id: 'web-fetch',
  skills: [join(import.meta.dirname, 'skills', 'web-fetch')],
  capabilities: ({ audit, deadline }) => [
    capability(createWebFetchTool({ audit, invocationDeadline: deadline }), false),
  ],
});
