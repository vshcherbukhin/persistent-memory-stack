/** Advanced personal graph reads share the same strict filter contract as recall. */
import { z } from 'zod'
import { KnowledgeFilters } from '@pm/shared'
import { ApiError } from '../errors.ts'
import { FactEdge, TimelineEntry, Contradiction, ok, fromApiError, graphResponseContractError, graphContradictionResponseContractError, RO_ANNOTATIONS } from '../schemas.ts'
import type { RegisterFn } from './context.ts'

export const registerGraphTools: RegisterFn = (server, { api }) => {
  const filters = {surface:z.literal('personal').optional(),...KnowledgeFilters.shape}
  const apiFilters = (input:Record<string,unknown>) => {const{surface:_surface,...body}=input;return body}
  server.registerTool('search_graph', {
    title:'Search personal graph evidence',description:'Bounded temporal graph retrieval from current authorized sources. Omitted filters span the personal space; explicit project/topic/type/status/time filters remain strict.',
    inputSchema:{query:z.string().min(1),...filters,limit:z.number().int().min(1).max(100).default(10),validOnly:z.boolean().default(false),centerNodeUuid:z.string().optional()},
    outputSchema:{facts:z.array(FactEdge)},annotations:RO_ANNOTATIONS,
  },async input=>{try{const result=await api.post<{facts:unknown[]}>('/graph/search',apiFilters(input));const error=graphResponseContractError('search_graph',result.facts);return error??ok(`${result.facts.length} graph fact(s).`,result)}catch(error){if(error instanceof ApiError)return fromApiError(error);throw error}})
  server.registerTool('get_entity',{
    title:'Expand a resolved personal entity',description:'Read evidence about an entity within the personal space and complete strict filters. Similar names do not establish equivalent facts or ownership.',
    inputSchema:{name:z.string().min(1),...filters,limit:z.number().int().min(1).max(100).default(20)},outputSchema:{name:z.string(),facts:z.array(FactEdge)},annotations:RO_ANNOTATIONS,
  },async input=>{try{const{name,...query}=input;const result=await api.get<{name:string;facts:unknown[]}>(`/graph/entity/${encodeURIComponent(name)}`,apiFilters(query));const error=graphResponseContractError('get_entity',result.facts);return error??ok(`Entity ${name}.`,result)}catch(error){if(error instanceof ApiError)return fromApiError(error);throw error}})
  server.registerTool('get_timeline',{
    title:'Read supported personal timeline',description:'Read bounded temporal evidence with strict personal filters and current source validation. Accepted canonical revision history remains separately recoverable.',
    inputSchema:{...filters,entityUuid:z.string().optional(),includeInvalid:z.boolean().default(true),limit:z.number().int().min(1).max(100).default(20)},outputSchema:{entityUuid:z.string().nullable(),entries:z.array(TimelineEntry)},annotations:RO_ANNOTATIONS,
  },async input=>{try{const result=await api.get<{entityUuid:string|null;entries:unknown[]}>('/graph/timeline',apiFilters(input));const error=graphResponseContractError('get_timeline',result.entries);return error??ok(`${result.entries.length} timeline entry(ies).`,result)}catch(error){if(error instanceof ApiError)return fromApiError(error);throw error}})
  server.registerTool('get_contradictions',{
    title:'Inspect personal temporal contradictions',description:'Return supported temporal contradictions within the complete strict filter contract; no default folder/project restriction.',
    inputSchema:{...filters,entityUuid:z.string().optional(),limit:z.number().int().min(1).max(100).default(20)},outputSchema:{contradictions:z.array(Contradiction)},annotations:RO_ANNOTATIONS,
  },async input=>{try{const result=await api.get<{contradictions:unknown[]}>('/graph/contradictions',apiFilters(input));const error=graphContradictionResponseContractError('get_contradictions',result.contradictions);return error??ok(`${result.contradictions.length} contradiction(s).`,result)}catch(error){if(error instanceof ApiError)return fromApiError(error);throw error}})
}
