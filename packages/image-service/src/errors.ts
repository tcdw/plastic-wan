import type { SafeError } from './contracts.ts';

export type ErrorStage = NonNullable<SafeError['stage']>;

/**
 * Every failure that crosses a core boundary is an AppError: a stable code plus a
 * message we authored ourselves (never upstream text, config text or an exception
 * message that could carry a secret). HTTP status mapping belongs to the adapters
 * that expose the core, not to the domain.
 */
export class AppError extends Error {
  readonly code: string;
  readonly stage?: ErrorStage | undefined;

  constructor(code: string, message: string, stage?: ErrorStage | undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.stage = stage;
  }

  toSafeError(): SafeError {
    return this.stage === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, stage: this.stage };
  }
}

export const inputError = (code: string, message: string): AppError => new AppError(code, message, 'input');

export const forbidden = (message = '权限不足'): AppError => new AppError('forbidden', message);

export const notFound = (message = '对象不存在'): AppError => new AppError('not_found', message);

export const conflict = (code: string, message: string): AppError => new AppError(code, message, 'input');

export const providerFailure = (code: string, message: string): AppError => new AppError(code, message, 'provider');

export const storageFailure = (code: string, message: string): AppError => new AppError(code, message, 'storage');

export const configUnavailable = (message = '模型配置当前不可用'): AppError => new AppError('config_invalid', message);
