import type { ToolSchemaKeywords } from './config.ts';

/**
 * How much of a tool definition's JSON Schema reaches one model.
 *
 * Tool schemas are written once (TypeBox) and sent to every endpoint, but not
 * every endpoint reads the same JSON Schema. Endpoints that fold tool parameters
 * into a decoding grammar reject the validation-only keywords outright:
 *
 *   failed to translate request: folding the request grammar: grammar rejected:
 *   tool "read" parameter schema: parameter "uri": unsupported schema keyword
 *   "minLength"
 *
 * and refuse alternatives, where one emitted value could be read two ways:
 *
 *   tool "brave__brave_web_search" parameter schema: parameter "goggles": more
 *   than one JSON reading of the same emitted value
 *
 * One rejected keyword fails the whole request with a 400 before the model
 * produces a token, so the run is lost. `minimal` sends the keywords that
 * describe the shape of a call — `type`, `properties`, `required`, `items`,
 * `enum`, `const` — and reduces everything a grammar folder refuses to fold:
 * the annotations that only narrow values afterwards, and the alternatives that
 * would leave one emitted value with two readings.
 *
 * Nothing here moves a bound: every tool validates what it is handed at the tool
 * boundary (an MCP tool compiles its own validator from the schema the server
 * published, before any reduction), so the dropped keywords were guidance for
 * the model, never the enforcement.
 */

/** Keys whose value is one subschema. */
const SUBSCHEMA_KEYS: ReadonlySet<string> = new Set(['items', 'additionalProperties']);

/** Keys whose value is a map of subschemas. */
const SUBSCHEMA_MAP_KEYS: ReadonlySet<string> = new Set(['properties', '$defs', 'definitions']);

/** Keys whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYS: ReadonlySet<string> = new Set(['prefixItems']);

/** Keywords that only narrow a value after the fact: no grammar needs them. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  'default',
  'format',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'patternProperties',
]);

/**
 * Alternatives and conditional applicators a grammar folder cannot fold: it has
 * to commit to one reading of every emitted value and rejects the request
 * instead of choosing — which is also why an untyped position is rejected. So
 * `anyOf` / `oneOf` collapse to the JSON type of their first typed variant, and
 * the siblings inside the union (an `enum`, a `pattern`) are not carried over:
 * the point is a foldable type, not a narrowed value space the tool boundary
 * enforces anyway.
 */
const FOLD_UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
  'unevaluatedItems',
]);

const ALTERNATIVE_KEYWORDS: ReadonlySet<string> = new Set(['anyOf', 'oneOf']);

const DROPPED_KEYWORDS: ReadonlySet<string> = new Set([...ANNOTATION_KEYWORDS, ...FOLD_UNSUPPORTED_KEYWORDS]);

/** The JSON type of the first variant that names one. */
function firstVariantType(variants: unknown): string | undefined {
  if (!Array.isArray(variants)) {
    return undefined;
  }
  for (const variant of variants) {
    if (typeof variant !== 'object' || variant === null || Array.isArray(variant)) {
      continue;
    }
    const type = (variant as Record<string, unknown>).type;
    if (typeof type === 'string') {
      return type;
    }
  }
  return undefined;
}

function reduceSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(reduceSchemaNode);
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }
  const reduced: Record<string, unknown> = {};
  let alternativeType: string | undefined;
  for (const [key, value] of Object.entries(node)) {
    if (ALTERNATIVE_KEYWORDS.has(key)) {
      alternativeType ??= firstVariantType(value);
      continue;
    }
    if (DROPPED_KEYWORDS.has(key)) {
      continue;
    }
    if (SUBSCHEMA_KEYS.has(key)) {
      reduced[key] = reduceSchemaNode(value);
      continue;
    }
    if (SUBSCHEMA_MAP_KEYS.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      reduced[key] = Object.fromEntries(
        Object.entries(value).map(([name, subschema]) => [name, reduceSchemaNode(subschema)]),
      );
      continue;
    }
    if (SUBSCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      reduced[key] = value.map(reduceSchemaNode);
      continue;
    }
    reduced[key] = value;
  }
  if (reduced.type === undefined && alternativeType !== undefined) {
    reduced.type = alternativeType;
  }
  return reduced;
}

/**
 * One tool schema reduced to the `minimal` profile. The input is never mutated:
 * the same TypeBox schema object is shared by every run of a Conversation and by
 * the capability registry, and only the copy handed to the model is reduced.
 */
export function minimalToolParameters<TParameters>(parameters: TParameters): TParameters {
  return reduceSchemaNode(parameters) as TParameters;
}

/**
 * The tools one request may carry, under a model's declared keyword profile. A
 * model that declares nothing keeps the schema exactly as the runtime built it.
 */
export function applyToolSchemaKeywords<TTool extends { readonly parameters: unknown }>(
  tools: readonly TTool[],
  keywords: ToolSchemaKeywords | undefined,
): TTool[] {
  if (keywords === undefined) {
    return [...tools];
  }
  return tools.map((tool) => ({ ...tool, parameters: minimalToolParameters(tool.parameters) }));
}
