/**
 * Репозиторий Graph RAG поверх Neo4j-онтологии (issue #363).
 *
 * Автоизвлечённые концепты/связи пишутся в тот же граф, что и ручная
 * онтология. Ручные (`authored`) элементы не перетираются, extracted-элементы
 * обновляются идемпотентно. Сводки сообществ хранятся отдельными узлами
 * `GraphCommunity`, потому что это производный материал для обзорного Graph RAG.
 */

import { runNeo4jRead, runNeo4jWrite } from '../neo4j.js';
import { invalidateOntologyCache, loadGameOntology } from './ontology.js';
import { detectCommunities } from '../../engine/graphCommunities.js';

export interface GraphCommunity {
  id: string;
  gameId: string;
  level: number;
  title: string;
  summary: string;
  memberSlugs: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface GraphEntity {
  properties?: Record<string, unknown>;
}

function properties(entity: unknown): Record<string, unknown> {
  if (entity && typeof entity === 'object' && 'properties' in entity) {
    const props = (entity as GraphEntity).properties;
    if (props && typeof props === 'object') return props;
  }
  if (entity && typeof entity === 'object') return entity as Record<string, unknown>;
  return {};
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (value && typeof value === 'object' && 'toNumber' in value) {
    const toNeo4jNumber = (value as { toNumber?: () => number }).toNumber;
    if (typeof toNeo4jNumber === 'function') return toNeo4jNumber.call(value);
  }
  return fallback;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((part) => String(part)) : [];
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toStandardDate' in value) {
    const toStandardDate = (value as { toStandardDate?: () => Date }).toStandardDate;
    if (typeof toStandardDate === 'function') return toStandardDate.call(value);
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date;
  }
  return new Date(0);
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapCommunity(entity: unknown): GraphCommunity {
  const row = properties(entity);
  return {
    id: String(row.id ?? ''),
    gameId: String(row.gameId ?? ''),
    level: toNumber(row.level, 0),
    title: String(row.title ?? ''),
    summary: String(row.summary ?? ''),
    memberSlugs: toStringArray(row.memberSlugs),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function boolFromRecord(value: unknown): boolean {
  return value === true;
}

const communitiesCache = new Map<string, GraphCommunity[]>();

export function invalidateCommunitiesCache(gameId: string): void {
  communitiesCache.delete(gameId);
}

export async function loadGameCommunities(gameId: string): Promise<GraphCommunity[]> {
  const cached = communitiesCache.get(gameId);
  if (cached) return cached;
  const communities = await listGraphCommunities(gameId);
  communitiesCache.set(gameId, communities);
  return communities;
}

export async function listGraphCommunities(gameId: string): Promise<GraphCommunity[]> {
  return await runNeo4jRead(async (tx) => {
    const result = await tx.run(
      `
      MATCH (c:GraphCommunity {gameId: $gameId})
      RETURN c
      ORDER BY c.level ASC, c.title ASC
      `,
      { gameId },
    );
    return result.records.map((record) => mapCommunity(record.get('c')));
  });
}

export interface GraphCommunitySeed {
  level?: number;
  title: string;
  summary: string;
  memberSlugs: string[];
}

export async function replaceGraphCommunities(
  gameId: string,
  communities: GraphCommunitySeed[],
): Promise<{ communities: number }> {
  const written = await runNeo4jWrite(async (tx) => {
    await tx.run('MATCH (c:GraphCommunity {gameId: $gameId}) DETACH DELETE c', { gameId });
    let count = 0;
    for (const c of communities) {
      const result = await tx.run(
        `
        CREATE (c:GraphCommunity {
          id: randomUUID(),
          gameId: $gameId,
          level: $level,
          title: $title,
          summary: $summary,
          memberSlugs: $memberSlugs,
          createdAt: $now,
          updatedAt: $now
        })
        RETURN c
        `,
        {
          gameId,
          level: c.level ?? 0,
          title: c.title,
          summary: c.summary,
          memberSlugs: c.memberSlugs,
          now: nowIso(),
        },
      );
      count += result.records.length;
    }
    return count;
  });
  invalidateCommunitiesCache(gameId);
  return { communities: written };
}

/**
 * Сидирует сообщества графа из уже имеющейся онтологии без LLM (issue #371).
 *
 * Идемпотентно: если для игры уже есть узлы GraphCommunity — ничего не делает.
 * Если сообщества пусты (например, после перехода хранилища на Neo4j), строит
 * детерминированные кластеры (`detectCommunities`) и записывает их без LLM-сводок
 * (summary = «»). Сводки появятся при следующем запуске с GRAPH_RAG_REINDEX_ON_START.
 */
export async function seedGraphCommunities(gameId: string): Promise<{ communities: number }> {
  const existing = await listGraphCommunities(gameId);
  if (existing.length > 0) return { communities: 0 };

  const ontology = await loadGameOntology(gameId);
  const detected = detectCommunities(ontology);
  if (detected.length === 0) return { communities: 0 };

  const seeds: GraphCommunitySeed[] = detected.map((c) => ({
    level: 0,
    title: c.anchorTitle,
    summary: '',
    memberSlugs: c.memberSlugs,
  }));
  return replaceGraphCommunities(gameId, seeds);
}

export interface ExtractedConceptInput {
  slug: string;
  kind: string;
  title: string;
  synonyms?: string[];
  fact?: string;
  weight?: number;
}

export interface ExtractedRelationInput {
  fromSlug: string;
  toSlug: string;
  relation: string;
  weight?: number;
  condition?: Record<string, unknown> | null;
  note?: string;
}

export interface ExtractedGraphInput {
  concepts: ExtractedConceptInput[];
  relations: ExtractedRelationInput[];
}

export async function applyExtractedGraph(
  gameId: string,
  graph: ExtractedGraphInput,
  sourceDocumentId: string | null,
): Promise<{ concepts: number; relations: number }> {
  if (graph.concepts.length === 0 && graph.relations.length === 0) {
    return { concepts: 0, relations: 0 };
  }

  const summary = await runNeo4jWrite(async (tx) => {
    let concepts = 0;
    let relations = 0;
    for (const c of graph.concepts) {
      const result = await tx.run(
        `
        MERGE (c:OntologyConcept {gameId: $gameId, slug: $slug})
        ON CREATE SET
          c.id = randomUUID(),
          c.kind = $kind,
          c.title = $title,
          c.synonyms = $synonyms,
          c.fact = $fact,
          c.weight = $weight,
          c.origin = 'extracted',
          c.createdAt = $now,
          c.updatedAt = $now,
          c.sourceDocumentId = $sourceDocumentId
        ON MATCH SET
          c.kind = CASE WHEN c.origin = 'extracted' THEN $kind ELSE c.kind END,
          c.title = CASE WHEN c.origin = 'extracted' THEN $title ELSE c.title END,
          c.synonyms = CASE WHEN c.origin = 'extracted' THEN $synonyms ELSE c.synonyms END,
          c.fact = CASE WHEN c.origin = 'extracted' THEN $fact ELSE c.fact END,
          c.weight = CASE WHEN c.origin = 'extracted' THEN $weight ELSE c.weight END,
          c.sourceDocumentId = CASE WHEN c.origin = 'extracted' THEN $sourceDocumentId ELSE c.sourceDocumentId END,
          c.updatedAt = CASE WHEN c.origin = 'extracted' THEN $now ELSE c.updatedAt END
        RETURN c.origin = 'extracted' AS written
        `,
        {
          gameId,
          slug: c.slug,
          kind: c.kind,
          title: c.title,
          synonyms: c.synonyms ?? [],
          fact: c.fact ?? '',
          weight: c.weight ?? 1.0,
          sourceDocumentId,
          now: nowIso(),
        },
      );
      concepts += result.records.filter((record) => boolFromRecord(record.get('written'))).length;
    }
    for (const r of graph.relations) {
      const result = await tx.run(
        `
        MATCH (from:OntologyConcept {gameId: $gameId, slug: $fromSlug})
        MATCH (to:OntologyConcept {gameId: $gameId, slug: $toSlug})
        MERGE (from)-[r:ONTOLOGY_RELATION {gameId: $gameId, relation: $relation}]->(to)
        ON CREATE SET
          r.id = randomUUID(),
          r.weight = $weight,
          r.note = $note,
          r.origin = 'extracted',
          r.createdAt = $now,
          r.updatedAt = $now,
          r.conditionJson = $conditionJson,
          r.sourceDocumentId = $sourceDocumentId
        ON MATCH SET
          r.weight = CASE WHEN r.origin = 'extracted' THEN $weight ELSE r.weight END,
          r.conditionJson = CASE WHEN r.origin = 'extracted' THEN $conditionJson ELSE r.conditionJson END,
          r.note = CASE WHEN r.origin = 'extracted' THEN $note ELSE r.note END,
          r.sourceDocumentId = CASE WHEN r.origin = 'extracted' THEN $sourceDocumentId ELSE r.sourceDocumentId END,
          r.updatedAt = CASE WHEN r.origin = 'extracted' THEN $now ELSE r.updatedAt END
        RETURN r.origin = 'extracted' AS written
        `,
        {
          gameId,
          fromSlug: r.fromSlug,
          toSlug: r.toSlug,
          relation: r.relation,
          weight: r.weight ?? 1.0,
          conditionJson: r.condition ? JSON.stringify(r.condition) : null,
          note: r.note ?? '',
          sourceDocumentId,
          now: nowIso(),
        },
      );
      relations += result.records.filter((record) => boolFromRecord(record.get('written'))).length;
    }
    return { concepts, relations };
  });

  invalidateOntologyCache(gameId);
  return summary;
}

export async function verifyOntologyConcept(gameId: string, id: string): Promise<boolean> {
  const verified = await runNeo4jWrite(async (tx) => {
    const result = await tx.run(
      `
      MATCH (c:OntologyConcept {gameId: $gameId, id: $id, origin: 'extracted'})
      SET c.origin = 'authored', c.updatedAt = $now
      RETURN c
      `,
      { gameId, id, now: nowIso() },
    );
    return result.records.length > 0;
  });
  invalidateOntologyCache(gameId);
  return verified;
}

export async function verifyOntologyRelation(gameId: string, id: string): Promise<boolean> {
  const verified = await runNeo4jWrite(async (tx) => {
    const result = await tx.run(
      `
      MATCH (:OntologyConcept {gameId: $gameId})-[r:ONTOLOGY_RELATION {gameId: $gameId, id: $id, origin: 'extracted'}]->(:OntologyConcept {gameId: $gameId})
      SET r.origin = 'authored', r.updatedAt = $now
      RETURN r
      `,
      { gameId, id, now: nowIso() },
    );
    return result.records.length > 0;
  });
  invalidateOntologyCache(gameId);
  return verified;
}
