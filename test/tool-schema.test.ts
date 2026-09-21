import { expect, test } from 'vitest';
import Type from 'typebox';
import Compile from 'typebox/compile';
import { applyToolSchemaKeywords, minimalToolParameters } from '../src/platform/tool-schema.ts';

/**
 * A grammar-constrained endpoint rejects the whole request when one tool schema
 * carries something it cannot fold into a decoding grammar
 * (`unsupported schema keyword "minLength"`, `more than one JSON reading of the
 * same emitted value`), so `minimal` reduces the schema to the shape of a call.
 */
test('minimal keeps the shape of a call and drops the validation-only keywords', () => {
  const parameters = {
    type: 'object',
    $schema: 'http://json-schema.org/draft-07/schema#',
    required: ['uri'],
    additionalProperties: false,
    properties: {
      uri: {
        type: 'string',
        description: 'A system:/// document',
        minLength: 1,
        maxLength: 512,
        pattern: 'system-prefix',
      },
      count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      tags: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true },
      mode: { anyOf: [{ const: 'a' }, { const: 'b' }], description: 'mode of operation' },
    },
  };

  expect(minimalToolParameters(parameters)).toEqual({
    type: 'object',
    required: ['uri'],
    additionalProperties: false,
    properties: {
      uri: { type: 'string', description: 'A system:/// document' },
      count: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      // The alternative goes, the documentation of the parameter stays.
      mode: { description: 'mode of operation' },
    },
  });
});

test('minimal reduces a free-form record to a bare object', () => {
  const parameters = Type.Record(Type.String(), Type.Unknown());

  expect(JSON.stringify(parameters)).toContain('patternProperties');
  expect(minimalToolParameters(parameters)).toEqual({ type: 'object' });
});

test('minimal reaches every subschema position, not just properties', () => {
  const parameters = {
    type: 'object',
    properties: {
      tuple: {
        type: 'array',
        prefixItems: [
          { type: 'string', minLength: 1 },
          { type: 'number', minimum: 0 },
        ],
      },
      free: { type: 'object', additionalProperties: { type: 'string', maxLength: 8 } },
      nested: { $defs: { inner: { type: 'string', minLength: 2 } }, $ref: '#/$defs/inner' },
    },
  };

  expect(minimalToolParameters(parameters)).toEqual({
    type: 'object',
    properties: {
      tuple: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
      free: { type: 'object', additionalProperties: { type: 'string' } },
      nested: { $defs: { inner: { type: 'string' } }, $ref: '#/$defs/inner' },
    },
  });
});

test('minimal collapses a union to the type of its first typed variant', () => {
  // The shape brave's MCP tools publish: a value that could be read as a string
  // or as an array of strings is rejected as "more than one JSON reading".
  const parameters = {
    type: 'object',
    properties: {
      goggles: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Goggles',
      },
      freshness: {
        anyOf: [
          { type: 'string', enum: ['pd', 'pw'] },
          { type: 'string', pattern: 'date-range' },
        ],
      },
      units: {
        oneOf: [
          { type: 'string', const: 'metric' },
          { type: 'string', const: 'imperial' },
        ],
      },
      // No variant names a type, so there is nothing to collapse to.
      nameless: { anyOf: [{ const: 'a' }, { const: 'b' }], description: 'documentation only' },
    },
  };

  expect(minimalToolParameters(parameters)).toEqual({
    type: 'object',
    properties: {
      goggles: { type: 'string', description: 'Goggles' },
      freshness: { type: 'string' },
      units: { type: 'string' },
      nameless: { description: 'documentation only' },
    },
  });
});

test('minimal never mutates the schema it was handed', () => {
  const parameters = Type.Object({ uri: Type.String({ minLength: 1 }) }, { additionalProperties: false });
  const before = JSON.stringify(parameters);

  const reduced = minimalToolParameters(parameters);

  expect(JSON.stringify(parameters)).toBe(before);
  expect(reduced).not.toBe(parameters);
  expect(JSON.stringify(reduced)).not.toContain('minLength');
});

test('a reduced schema still accepts the arguments the original accepted', () => {
  const original = Type.Object(
    {
      uri: Type.String({ minLength: 1, maxLength: 8 }),
      mode: Type.Optional(Type.Union([Type.Literal('a'), Type.Literal('b')])),
      tags: Type.Optional(Type.Array(Type.String(), { minItems: 2 })),
    },
    { additionalProperties: false },
  );
  const reduced = minimalToolParameters(original);
  const originalValidator = Compile(original);
  const reducedValidator = Compile(reduced);

  const samples = [
    { uri: 'system:///x' },
    { uri: 'a', mode: 'b', tags: ['x', 'y'] },
    { uri: 'longer-than-the-original-allows', tags: ['x'] },
    { uri: 'a', mode: 'c' },
  ];
  for (const sample of samples) {
    if (originalValidator.Check(sample)) {
      expect(reducedValidator.Check(sample)).toBe(true);
    }
  }
  // The reduction is a relaxation: what the original rejected may pass here, and
  // the tool boundary is what rejects it again.
  expect(originalValidator.Check({ uri: '' })).toBe(false);
  expect(reducedValidator.Check({ uri: '' })).toBe(true);
});

test('a model that declares no profile keeps the tools exactly as they were built', () => {
  const tools = [{ name: 'read', description: 'Read', parameters: { type: 'string', minLength: 1 }, execute: 1 }];

  const kept = applyToolSchemaKeywords(tools, undefined);

  expect(kept).toEqual(tools);
  expect(kept[0]).toBe(tools[0]);
});

test('a minimal profile reduces every tool without touching the rest of the definition', () => {
  const execute = (): string => 'ran';
  const tools = [
    { name: 'read', description: 'Read', parameters: { type: 'string', minLength: 1 }, execute },
    {
      name: 'send',
      description: 'Send',
      parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 4096 } } },
    },
  ];

  const reduced = applyToolSchemaKeywords(tools, 'minimal');

  expect(reduced).toEqual([
    { name: 'read', description: 'Read', parameters: { type: 'string' }, execute },
    { name: 'send', description: 'Send', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
  ]);
  expect(reduced[0]?.execute).toBe(execute);
  expect(reduced[0]).not.toBe(tools[0]);
});
