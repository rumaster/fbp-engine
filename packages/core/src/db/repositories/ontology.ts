/**
 * Репозиторий концептуальной онтологии игры в Neo4j (issue #363).
 *
 * Runtime-движок и админка работают с тем же доменным контрактом, что и раньше:
 * концепты, типизированные связи, origin/sourceDocumentId и кеш графа на процесс.
 * Хранилище теперь нативно графовое: концепты — узлы `OntologyConcept`, связи —
 * отношения `ONTOLOGY_RELATION` между ними.
 */

import { runNeo4jRead, runNeo4jWrite, type Neo4jQueryRunner } from '../neo4j.js';
import type {
  OntologyConceptNode,
  OntologyGraph,
  OntologyRelationEdge,
} from '../../engine/ontologyRetrieval.js';

export type OntologyOrigin = 'authored' | 'extracted';

export interface OntologyConcept extends OntologyConceptNode {
  id: string;
  gameId: string;
  sourceDocumentId: string | null;
  origin: OntologyOrigin;
  createdAt: Date;
  updatedAt: Date;
}

export interface OntologyRelation extends OntologyRelationEdge {
  id: string;
  gameId: string;
  sourceDocumentId: string | null;
  origin: OntologyOrigin;
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

function normalizeOrigin(value: unknown): OntologyOrigin {
  return value === 'extracted' ? 'extracted' : 'authored';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCondition(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapConceptEntity(entity: unknown): OntologyConcept {
  const row = properties(entity);
  return {
    id: String(row.id ?? ''),
    gameId: String(row.gameId ?? ''),
    slug: String(row.slug ?? ''),
    kind: String(row.kind ?? ''),
    title: String(row.title ?? ''),
    synonyms: toStringArray(row.synonyms),
    fact: String(row.fact ?? ''),
    weight: toNumber(row.weight, 1),
    sourceDocumentId: optionalString(row.sourceDocumentId),
    origin: normalizeOrigin(row.origin),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function mapRelationEntity(entity: unknown, fromSlug: unknown, toSlug: unknown): OntologyRelation {
  const row = properties(entity);
  return {
    id: String(row.id ?? ''),
    gameId: String(row.gameId ?? ''),
    fromSlug: String(fromSlug ?? row.fromSlug ?? ''),
    toSlug: String(toSlug ?? row.toSlug ?? ''),
    relation: String(row.relation ?? ''),
    weight: toNumber(row.weight, 1),
    condition: parseCondition(row.conditionJson ?? row.condition),
    note: String(row.note ?? ''),
    sourceDocumentId: optionalString(row.sourceDocumentId),
    origin: normalizeOrigin(row.origin),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

const graphCache = new Map<string, OntologyGraph>();

export function invalidateOntologyCache(gameId: string): void {
  graphCache.delete(gameId);
}

async function loadConcepts(tx: Neo4jQueryRunner, gameId: string): Promise<OntologyConcept[]> {
  const result = await tx.run(
    `
    MATCH (c:OntologyConcept {gameId: $gameId})
    RETURN c
    ORDER BY c.weight DESC, c.title ASC
    `,
    { gameId },
  );
  return result.records.map((record) => mapConceptEntity(record.get('c')));
}

async function loadRelations(tx: Neo4jQueryRunner, gameId: string): Promise<OntologyRelation[]> {
  const result = await tx.run(
    `
    MATCH (from:OntologyConcept {gameId: $gameId})-[r:ONTOLOGY_RELATION {gameId: $gameId}]->(to:OntologyConcept {gameId: $gameId})
    RETURN r, from.slug AS fromSlug, to.slug AS toSlug
    ORDER BY from.slug ASC, to.slug ASC, r.relation ASC
    `,
    { gameId },
  );
  return result.records.map((record) =>
    mapRelationEntity(record.get('r'), record.get('fromSlug'), record.get('toSlug')),
  );
}

export async function loadGameOntology(gameId: string): Promise<OntologyGraph> {
  const cached = graphCache.get(gameId);
  if (cached) return cached;

  const graph = await runNeo4jRead(async (tx) => ({
    concepts: await loadConcepts(tx, gameId),
    relations: await loadRelations(tx, gameId),
  }));
  graphCache.set(gameId, graph);
  return graph;
}

export async function listOntologyConcepts(gameId: string): Promise<OntologyConcept[]> {
  return await runNeo4jRead((tx) => loadConcepts(tx, gameId));
}

export async function listOntologyRelations(gameId: string): Promise<OntologyRelation[]> {
  return await runNeo4jRead((tx) => loadRelations(tx, gameId));
}

export interface OntologyConceptInput {
  slug: string;
  kind: string;
  title: string;
  synonyms?: string[];
  fact?: string;
  weight?: number;
}

export interface OntologyRelationInput {
  fromSlug: string;
  toSlug: string;
  relation: string;
  weight?: number;
  condition?: Record<string, unknown> | null;
  note?: string;
}

export async function createOntologyConcept(
  gameId: string,
  input: OntologyConceptInput,
): Promise<OntologyConcept> {
  const created = await runNeo4jWrite(async (tx) => {
    const result = await tx.run(
      `
      CREATE (c:OntologyConcept {
        id: randomUUID(),
        gameId: $gameId,
        slug: $slug,
        kind: $kind,
        title: $title,
        synonyms: $synonyms,
        fact: $fact,
        weight: $weight,
        origin: 'authored',
        createdAt: $now,
        updatedAt: $now
      })
      RETURN c
      `,
      {
        gameId,
        slug: input.slug,
        kind: input.kind,
        title: input.title,
        synonyms: input.synonyms ?? [],
        fact: input.fact ?? '',
        weight: input.weight ?? 1.0,
        now: nowIso(),
      },
    );
    return result.records[0] ? mapConceptEntity(result.records[0].get('c')) : null;
  });
  if (!created) throw new Error('Не удалось создать концепт онтологии');
  invalidateOntologyCache(gameId);
  return created;
}

export async function updateOntologyConcept(
  gameId: string,
  id: string,
  input: OntologyConceptInput,
): Promise<OntologyConcept | null> {
  const updated = await runNeo4jWrite(async (tx) => {
    const result = await tx.run(
      `
      MATCH (c:OntologyConcept {gameId: $gameId, id: $id})
      SET c.slug = $slug,
          c.kind = $kind,
          c.title = $title,
          c.synonyms = $synonyms,
          c.fact = $fact,
          c.weight = $weight,
          c.updatedAt = $now
      RETURN c
      `,
      {
        gameId,
        id,
        slug: input.slug,
        kind: input.kind,
        title: input.title,
        synonyms: input.synonyms ?? [],
        fact: input.fact ?? '',
        weight: input.weight ?? 1.0,
        now: nowIso(),
      },
    );
    return result.records[0] ? mapConceptEntity(result.records[0].get('c')) : null;
  });
  invalidateOntologyCache(gameId);
  return updated;
}

export async function deleteOntologyConcept(gameId: string, id: string): Promise<boolean> {
  const deleted = await runNeo4jWrite(async (tx) => {
    const result = await tx.run(
      `
      MATCH (c:OntologyConcept {gameId: $gameId, id: $id})
      WITH c, c.id AS id
      DETACH DELETE c
      RETURN id
      `,
      { gameId, id },
    );
    return result.records.length > 0;
  });
  invalidateOntologyCache(gameId);
  return deleted;
}

export async function createOntologyRelation(
  gameId: string,
  input: OntologyRelationInput,
): Promise<OntologyRelation> {
  const created = await runNeo4jWrite(async (tx) => {
    const result = await tx.run(
      `
      MATCH (from:OntologyConcept {gameId: $gameId, slug: $fromSlug})
      MATCH (to:OntologyConcept {gameId: $gameId, slug: $toSlug})
      CREATE (from)-[r:ONTOLOGY_RELATION {
        id: randomUUID(),
        gameId: $gameId,
        relation: $relation,
        weight: $weight,
        note: $note,
        origin: 'authored',
        createdAt: $now,
        updatedAt: $now
      }]->(to)
      SET r.conditionJson = $conditionJson
      RETURN r, from.slug AS fromSlug, to.slug AS toSlug
      `,
      {
        gameId,
        fromSlug: input.fromSlug,
        toSlug: input.toSlug,
        relation: input.relation,
        weight: input.weight ?? 1.0,
        conditionJson: input.condition ? JSON.stringify(input.condition) : null,
        note: input.note ?? '',
        now: nowIso(),
      },
    );
    return result.records[0]
      ? mapRelationEntity(
          result.records[0].get('r'),
          result.records[0].get('fromSlug'),
          result.records[0].get('toSlug'),
        )
      : null;
  });
  if (!created) throw new Error('Не удалось создать связь онтологии: концепты не найдены');
  invalidateOntologyCache(gameId);
  return created;
}

export async function updateOntologyRelation(
  gameId: string,
  id: string,
  input: OntologyRelationInput,
): Promise<OntologyRelation | null> {
  const updated = await runNeo4jWrite(async (tx) => {
    const result = await tx.run(
      `
      MATCH (:OntologyConcept {gameId: $gameId})-[old:ONTOLOGY_RELATION {gameId: $gameId, id: $id}]->(:OntologyConcept {gameId: $gameId})
      MATCH (from:OntologyConcept {gameId: $gameId, slug: $fromSlug})
      MATCH (to:OntologyConcept {gameId: $gameId, slug: $toSlug})
      WITH old, from, to, old.createdAt AS createdAt, old.sourceDocumentId AS sourceDocumentId, old.origin AS origin
      DELETE old
      CREATE (from)-[r:ONTOLOGY_RELATION {
        id: $id,
        gameId: $gameId,
        relation: $relation,
        weight: $weight,
        note: $note,
        origin: coalesce(origin, 'authored'),
        createdAt: coalesce(createdAt, $now),
        updatedAt: $now
      }]->(to)
      SET r.conditionJson = $conditionJson,
          r.sourceDocumentId = sourceDocumentId
      RETURN r, from.slug AS fromSlug, to.slug AS toSlug
      `,
      {
        gameId,
        id,
        fromSlug: input.fromSlug,
        toSlug: input.toSlug,
        relation: input.relation,
        weight: input.weight ?? 1.0,
        conditionJson: input.condition ? JSON.stringify(input.condition) : null,
        note: input.note ?? '',
        now: nowIso(),
      },
    );
    return result.records[0]
      ? mapRelationEntity(
          result.records[0].get('r'),
          result.records[0].get('fromSlug'),
          result.records[0].get('toSlug'),
        )
      : null;
  });
  invalidateOntologyCache(gameId);
  return updated;
}

export async function deleteOntologyRelation(gameId: string, id: string): Promise<boolean> {
  const deleted = await runNeo4jWrite(async (tx) => {
    const result = await tx.run(
      `
      MATCH (:OntologyConcept {gameId: $gameId})-[r:ONTOLOGY_RELATION {gameId: $gameId, id: $id}]->(:OntologyConcept {gameId: $gameId})
      WITH r, r.id AS id
      DELETE r
      RETURN id
      `,
      { gameId, id },
    );
    return result.records.length > 0;
  });
  invalidateOntologyCache(gameId);
  return deleted;
}

export interface OntologyConceptSeed {
  slug: string;
  kind: string;
  title: string;
  synonyms?: string[];
  fact?: string;
  weight?: number;
}

export interface OntologyRelationSeed {
  fromSlug: string;
  toSlug: string;
  relation: string;
  weight?: number;
  condition?: Record<string, unknown> | null;
  note?: string;
}

export interface OntologySeed {
  concepts: OntologyConceptSeed[];
  relations: OntologyRelationSeed[];
}

export async function seedGameOntology(
  gameId: string,
  seed: OntologySeed,
): Promise<{ concepts: number; relations: number }> {
  if (seed.concepts.length === 0 && seed.relations.length === 0) {
    return { concepts: 0, relations: 0 };
  }

  const summary = await runNeo4jWrite(async (tx) => {
    let concepts = 0;
    let relations = 0;
    for (const c of seed.concepts) {
      const result = await tx.run(
        `
        OPTIONAL MATCH (existing:OntologyConcept {gameId: $gameId, slug: $slug})
        WITH existing
        WHERE existing IS NULL
        CREATE (c:OntologyConcept {
          id: randomUUID(),
          gameId: $gameId,
          slug: $slug,
          kind: $kind,
          title: $title,
          synonyms: $synonyms,
          fact: $fact,
          weight: $weight,
          origin: 'authored',
          createdAt: $now,
          updatedAt: $now
        })
        RETURN c
        `,
        {
          gameId,
          slug: c.slug,
          kind: c.kind,
          title: c.title,
          synonyms: c.synonyms ?? [],
          fact: c.fact ?? '',
          weight: c.weight ?? 1.0,
          now: nowIso(),
        },
      );
      concepts += result.records.length;
    }
    for (const r of seed.relations) {
      const result = await tx.run(
        `
        MATCH (from:OntologyConcept {gameId: $gameId, slug: $fromSlug})
        MATCH (to:OntologyConcept {gameId: $gameId, slug: $toSlug})
        OPTIONAL MATCH (from)-[existing:ONTOLOGY_RELATION {gameId: $gameId, relation: $relation}]->(to)
        WITH from, to, existing
        WHERE existing IS NULL
        CREATE (from)-[r:ONTOLOGY_RELATION {
          id: randomUUID(),
          gameId: $gameId,
          relation: $relation,
          weight: $weight,
          note: $note,
          origin: 'authored',
          createdAt: $now,
          updatedAt: $now
        }]->(to)
        SET r.conditionJson = $conditionJson
        RETURN r
        `,
        {
          gameId,
          fromSlug: r.fromSlug,
          toSlug: r.toSlug,
          relation: r.relation,
          weight: r.weight ?? 1.0,
          conditionJson: r.condition ? JSON.stringify(r.condition) : null,
          note: r.note ?? '',
          now: nowIso(),
        },
      );
      relations += result.records.length;
    }
    return { concepts, relations };
  });

  invalidateOntologyCache(gameId);
  return summary;
}
