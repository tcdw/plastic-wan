import { join } from 'node:path';
import { capability } from '../../capabilities/execute-tool.ts';
import { definePlugin } from '../plugin.ts';
import { createAlarmTool, createDeleteAlarmTool, createListAlarmTool } from './alarm.ts';

export { cancelAlarm, listAlarms, parseAlarmId } from './admin.ts';
export { createAlarmTool, createDeleteAlarmTool, createListAlarmTool } from './alarm.ts';

export default definePlugin({
  id: 'alarm',
  skills: [join(import.meta.dirname, 'skills', 'alarms')],
  capabilities: (scope) => [
    capability(createAlarmTool(scope), true),
    capability(createListAlarmTool(scope), false),
    capability(createDeleteAlarmTool(scope), true),
  ],
});
