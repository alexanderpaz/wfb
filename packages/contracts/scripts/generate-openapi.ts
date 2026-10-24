import { writeFileSync } from 'node:fs';
import { OpenApiGeneratorV31, OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z, type ZodTypeAny } from 'zod';
import { API_PREFIX, ApiError } from '../src/common.js';
import { routes, type RouteDef } from '../src/routes.js';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

for (const [name, def] of Object.entries(routes) as [string, RouteDef][]) {
  const path = API_PREFIX + def.path.replace(/:(\w+)/g, '{$1}');
  const params = [...def.path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
  registry.registerPath({
    operationId: name,
    method: def.method.toLowerCase() as 'get',
    path,
    summary: def.summary,
    security: def.auth ? [{ cookie: [] }] : [],
    request: {
      params: params.length ? z.object(Object.fromEntries(params.map((p) => [p, z.string()]))) : undefined,
      query: def.query as z.AnyZodObject | undefined,
      body: def.body ? { content: { 'application/json': { schema: def.body as ZodTypeAny } } } : undefined,
    },
    responses: {
      200: def.response
        ? { description: 'OK', content: { 'application/json': { schema: def.response } } }
        : { description: 'OK', content: { [def.produces ?? '*/*']: { schema: z.string() } } },
      default: { description: 'Error', content: { 'application/json': { schema: ApiError } } },
    },
  });
}

registry.registerComponent('securitySchemes', 'cookie', { type: 'apiKey', in: 'cookie', name: 'wfb_sid' });

const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
  openapi: '3.1.0',
  info: { title: 'Web File Browser API', version: '0.1.0' },
});

const out = process.argv[2] ?? 'openapi.json';
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`OpenAPI written to ${out}`);
