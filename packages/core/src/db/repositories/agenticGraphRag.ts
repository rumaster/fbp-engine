/**
 * Внутренний graph_query для agentic Graph RAG (#386).
 *
 * Узел читает существующий Neo4j-граф онтологии и отдаёт компактный список
 * концептов с соседями. Формат рассчитан на LLM-шаги `graph_rag`: минимум полей,
 * стабильные id и score для объяснимого ранжирования.
 */

import type { IEmbeddingProvider } from '../../llm/embeddings.js';
import { runNeo4jRead } from '../neo4j.js';

export interface GraphQueryEdge {
  relationType: string;
  neighborId: string;
  neighbor: string;
  neighborDescription: string;
}

export interface GraphQueryConcept {
  id: string;
  concept: string;
  description: string;
  score: number;
  edges: GraphQueryEdge[];
}

export interface QueryKnowledgeGraphOptions {
  gameId: string;
  keys: string[];
  embeddingProvider?: IEmbeddingProvider;
  topK?: number;
}

interface GraphEntity {
  properties?: Record<string, unknown>;
}

interface ConceptCandidate extends GraphQueryConcept {
  slug: string;
  keys: string[];
  keyEmbeddings: number[][];
}

const EXACT_MATCH_SCORE = 1_000_000;
const DEFAULT_TOP_K = 8;

export async function queryKnowledgeGraph(
  options: QueryKnowledgeGraphOptions,
): Promise<GraphQueryConcept[]> {
  const keys = uniqueStrings(options.keys);
  if (options.gameId.trim().length === 0 || keys.length === 0) return [];

  const candidates = await loadGraphCandidates(options.gameId);
  if (candidates.length === 0) return [];

  const topK = normalizeTopK(options.topK);
  const textKeys = keys.filter((key) => key.trim().length > 0);
  const embeddingScores = await rankByEmbeddings(textKeys, candidates, options.embeddingProvider);

  const ranked = candidates
    .map((candidate) => {
      const exact = hasExactMatch(candidate, keys);
      const lexical = exact ? EXACT_MATCH_SCORE : lexicalScore(candidate, textKeys);
      const semantic = embeddingScores.get(candidate.id) ?? 0;
      return { ...candidate, score: Math.max(lexical, semantic) };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.concept.localeCompare(b.concept, 'ru'));

  return ranked.slice(0, topK).map((item) => ({
    id: item.id,
    concept: item.concept,
    description: item.description,
    score: item.score,
    edges: item.edges,
  }));
}

async function loadGraphCandidates(gameId: string): Promise<ConceptCandidate[]> {
  return await runNeo4jRead(async (tx) => {
    const result = await tx.run(
      `
      MATCH (c:OntologyConcept {gameId: $gameId})
      OPTIONAL MATCH (c)-[r:ONTOLOGY_RELATION {gameId: $gameId}]->(n:OntologyConcept {gameId: $gameId})
      RETURN c, collect(CASE WHEN r IS NULL OR n IS NULL THEN null ELSE { relation: r, neighbor: n } END) AS edges
      `,
      { gameId },
    );
    return result.records.map((record) => mapConceptRecord(record.get('c'), record.get('edges')));
  });
}

function mapConceptRecord(entity: unknown, rawEdges: unknown): ConceptCandidate {
  const row = properties(entity);
  const id = stringValue(row.id ?? row.slug);
  const slug = stringValue(row.slug ?? row.id);
  const concept = stringValue(row.concept ?? row.title ?? row.slug ?? row.id);
  const description = stringValue(row.description ?? row.fact ?? row.kind);
  const keys = uniqueStrings([
    ...toStringArray(row.keys),
    ...toStringArray(row.synonyms),
    concept,
    slug,
    id,
  ]);
  return {
    id,
    slug,
    concept,
    description,
    score: 0,
    edges: Array.isArray(rawEdges) ? rawEdges.map(mapEdge).filter((edge): edge is GraphQueryEdge => edge !== null) : [],
    keys,
    keyEmbeddings: toEmbeddingMatrix(row.keyEmbeddings),
  };
}

function mapEdge(value: unknown): GraphQueryEdge | null {
  if (!isRecord(value)) return null;
  const relation = properties(value.relation);
  const neighbor = properties(value.neighbor);
  const neighborId = stringValue(neighbor.id ?? neighbor.slug);
  if (!neighborId) return null;
  return {
    relationType: stringValue(relation.relationType ?? relation.type ?? relation.relation),
    neighborId,
    neighbor: stringValue(neighbor.concept ?? neighbor.title ?? neighbor.slug ?? neighbor.id),
    neighborDescription: stringValue(neighbor.description ?? neighbor.fact ?? neighbor.kind),
  };
}

function properties(entity: unknown): Record<string, unknown> {
  if (entity && typeof entity === 'object' && 'properties' in entity) {
    const props = (entity as GraphEntity).properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) return props;
  }
  if (isRecord(entity)) return entity;
  return {};
}

function hasExactMatch(candidate: ConceptCandidate, keys: readonly string[]): boolean {
  const id = normalizeText(candidate.id);
  const slug = normalizeText(candidate.slug);
  return keys.some((key) => {
    const normalized = normalizeText(key);
    return normalized.length > 0 && (normalized === id || normalized === slug);
  });
}

async function rankByEmbeddings(
  keys: readonly string[],
  candidates: readonly ConceptCandidate[],
  embeddingProvider: IEmbeddingProvider | undefined,
): Promise<Map<string, number>> {
  if (!embeddingProvider || keys.length === 0) return new Map();
  if (!candidates.some((candidate) => candidate.keyEmbeddings.length > 0)) return new Map();

  const result = await embeddingProvider.embed([...keys]);
  const scores = new Map<string, number>();
  for (const candidate of candidates) {
    let best = 0;
    for (const queryEmbedding of result.embeddings) {
      for (const keyEmbedding of candidate.keyEmbeddings) {
        best = Math.max(best, cosineSimilarity(queryEmbedding, keyEmbedding));
      }
    }
    if (best > 0) scores.set(candidate.id, best);
  }
  return scores;
}

function lexicalScore(candidate: ConceptCandidate, keys: readonly string[]): number {
  let best = 0;
  const haystack = uniqueStrings([
    ...candidate.keys,
    candidate.concept,
    candidate.description,
  ]).map(normalizeText);
  for (const rawKey of keys) {
    const key = normalizeText(rawKey);
    if (!key) continue;
    for (const value of haystack) {
      if (!value) continue;
      if (value === key) best = Math.max(best, 0.95);
      else if (value.includes(key)) best = Math.max(best, 0.75);
      else if (key.includes(value) && value.length >= 4) best = Math.max(best, 0.5);
      else best = Math.max(best, wordOverlapScore(key, value));
    }
  }
  return best;
}

function wordOverlapScore(left: string, right: string): number {
  const leftWords = new Set(left.split(' ').filter((part) => part.length >= 4));
  const rightWords = right.split(' ').filter((part) => part.length >= 4);
  if (leftWords.size === 0 || rightWords.length === 0) return 0;
  const overlap = rightWords.filter((word) => leftWords.has(word)).length;
  return overlap === 0 ? 0 : Math.min(0.45, overlap / Math.max(leftWords.size, rightWords.length));
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  if (left <= 0 || right <= 0) return 0;
  return dot / (Math.sqrt(left) * Math.sqrt(right));
}

function toEmbeddingMatrix(value: unknown): number[][] {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  if (parsed.every((item) => typeof item === 'number')) return [parsed.filter(isFiniteNumber)];
  return parsed
    .filter(Array.isArray)
    .map((row) => row.filter(isFiniteNumber))
    .filter((row) => row.length > 0);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter((item) => item.length > 0)
    : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function normalizeTopK(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TOP_K;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
