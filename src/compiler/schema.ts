import { zodToJsonSchema } from 'zod-to-json-schema';
import { manifestSchema } from './validation';

/**
 * JSON Schema (draft-07) representation of the SectionManifest design contract.
 *
 * Derived directly from the deep zod schema in ./validation.ts so the served
 * schema can never drift from what the compiler actually accepts. The CORE
 * backend imports this and serves it at GET /v1/schema — keep the export name
 * and path stable (src/compiler/schema.ts → contractJsonSchema).
 *
 * `$refStrategy: 'none'` inlines shared definitions so the emitted document is
 * fully self-contained and easy to consume from any language.
 */
export function contractJsonSchema(): object {
  return zodToJsonSchema(manifestSchema, {
    name: 'SectionManifest',
    $refStrategy: 'none',
  });
}
