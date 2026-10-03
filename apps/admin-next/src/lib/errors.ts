import i18n from './i18n.ts';
import { ApiError } from './api.ts';

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : i18n.t('common.requestFailed');
}
