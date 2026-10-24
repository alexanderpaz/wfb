import { API_PREFIX, SearchQuery, type SearchResponse } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../lib/auth-context.js';
import { parse } from '../lib/validate.js';
import type { SearchService } from './service.js';

const p = (route: string) => `${API_PREFIX}${route}`;

export function registerSearchRoutes(app: FastifyInstance, search: SearchService): void {
  app.get(p('/search'), async (request): Promise<SearchResponse> => {
    const user = requireUser(request);
    return search.search(user, parse(SearchQuery, request.query));
  });
}

