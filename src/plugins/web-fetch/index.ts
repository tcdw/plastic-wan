import { join } from 'node:path';
import { capability } from '../../capabilities/execute-tool.ts';
import { definePlugin } from '../plugin.ts';
import { createWebFetchTool } from './web-fetch.ts';

export default definePlugin({
  id: 'web-fetch',
  skills: [join(import.meta.dirname, 'skills', 'web-fetch')],
  capabilities: ({ audit, config, deadline }) => [
    capability(
      createWebFetchTool({
        audit,
        invocationDeadline: deadline,
        allowProxySyntheticAddresses: config.web_fetch?.allow_proxy_synthetic_addresses === true,
      }),
      false,
    ),
  ],
});
