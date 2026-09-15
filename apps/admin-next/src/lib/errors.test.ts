import { describe, expect, test } from 'bun:test';
import { ApiError } from './api.ts';
import { errorMessage } from './errors.ts';

describe('errorMessage', () => {
  test('formats ApiErrors as code: message', () => {
    expect(errorMessage(new ApiError(409, 'alarm_not_pending', 'Only pending alarms can be cancelled'))).toBe(
      'alarm_not_pending: Only pending alarms can be cancelled',
    );
    expect(errorMessage(new ApiError(400, 'unknown_model', 'Model is not registered'))).toBe(
      'unknown_model: Model is not registered',
    );
  });

  test('falls back to Error.message and a generic string', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('raw')).toBe('Request failed');
    expect(errorMessage(undefined)).toBe('Request failed');
    expect(errorMessage(null)).toBe('Request failed');
  });
});
