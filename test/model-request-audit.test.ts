import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { scrubModelRequestAuditJson } from '../src/platform/model-request-audit.ts';

test('scrubs every inline base64 image while preserving other request data', () => {
  const first = Buffer.from('first image');
  const second = Buffer.from('second image');
  const source = {
    messages: [
      {
        content: [
          { type: 'text', text: 'data:text/plain;base64,dGV4dA==' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${first.toString('base64')}` } },
          { type: 'image_url', image_url: { url: `DATA:IMAGE/JPEG;name=x;BASE64,${second.toString('base64')}` } },
        ],
      },
    ],
  };

  const scrubbed = scrubModelRequestAuditJson(JSON.stringify(source));
  expect(scrubbed.replacements).toBe(2);
  expect(scrubbed.decodedBytes).toBe(first.byteLength + second.byteLength);
  expect(scrubbed.removedCharacters).toBe(Math.max(0, JSON.stringify(source).length - scrubbed.json.length));
  expect(scrubbed.json).not.toContain(first.toString('base64'));
  expect(scrubbed.json).not.toContain(second.toString('base64'));
  expect(JSON.parse(scrubbed.json)).toMatchObject({
    messages: [
      {
        content: [
          { text: 'data:text/plain;base64,dGV4dA==' },
          {
            image_url: {
              url: {
                __plasticwan_audit_omission__: 'base64_image',
                mime_type: 'image/png',
                decoded_bytes: first.byteLength,
                sha256: createHash('sha256').update(first).digest('hex'),
              },
            },
          },
          {
            image_url: {
              url: {
                __plasticwan_audit_omission__: 'base64_image',
                mime_type: 'image/jpeg',
                decoded_bytes: second.byteLength,
                sha256: createHash('sha256').update(second).digest('hex'),
              },
            },
          },
        ],
      },
    ],
  });
});

test('is idempotent for an already scrubbed request', () => {
  const original = JSON.stringify({ image: 'data:image/webp;base64,aW1hZ2U=' });
  const first = scrubModelRequestAuditJson(original);
  const second = scrubModelRequestAuditJson(first.json);
  expect(second.json).toBe(first.json);
  expect(second.replacements).toBe(0);
  expect(second.removedCharacters).toBe(0);
  expect(second.decodedBytes).toBe(0);
});
