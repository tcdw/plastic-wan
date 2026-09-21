import type { ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';

/** Pi's thinking levels, weakest first: this order is what "weakest" means. */
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * What Pi offers a reasoning model that declares nothing. `xhigh` and `max` only
 * count once a model maps them, so they are never assumed.
 */
const UNDECLARED_REASONING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

export interface ThinkingLevelSource {
  readonly reasoning: boolean;
  readonly thinking_levels?: readonly ModelThinkingLevel[];
}

export function isThinkingLevel(value: string): value is ModelThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * The levels a configured model accepts, weakest first. A model that is not a
 * reasoning model only has `off`; one that declares no list gets Pi's default.
 * `thinkingLevelMap` below is built so that Pi's `getSupportedThinkingLevels`
 * answers the same list for the registered model.
 */
export function supportedThinkingLevels(model: ThinkingLevelSource): readonly ModelThinkingLevel[] {
  if (!model.reasoning) {
    return ['off'];
  }
  const declared = model.thinking_levels;
  if (declared === undefined) {
    return UNDECLARED_REASONING_LEVELS;
  }
  return THINKING_LEVELS.filter((level) => declared.includes(level));
}

/**
 * Pi reads a model's levels from `thinkingLevelMap`: `null` marks a level as
 * unsupported, and `xhigh` / `max` are supported only when mapped. Every other
 * supported level stays unmapped, so each adapter keeps sending its own wire
 * value for it (Gemini's `LOW`, a budget for Anthropic's older models).
 */
export function thinkingLevelMap(model: ThinkingLevelSource): ThinkingLevelMap | undefined {
  const declared = model.thinking_levels;
  if (!model.reasoning || declared === undefined) {
    return undefined;
  }
  const map: ThinkingLevelMap = {};
  for (const level of THINKING_LEVELS) {
    if (!declared.includes(level)) {
      map[level] = null;
    } else if (level === 'xhigh' || level === 'max') {
      map[level] = level;
    }
  }
  return map;
}
