import { ApiError } from './api.ts';

/** Renders any thrown value as display text; ApiErrors include their stable code. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Request failed';
}
