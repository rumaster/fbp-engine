import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, {
  type Driver,
  type ManagedTransaction,
  type QueryResult,
  type Session,
} from 'neo4j-driver';

export class Neo4jOntologyConflictError extends Error {}

export interface Neo4jQueryRunner {
  run<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<QueryResult<T>>;
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

export interface OntologyImportPayload {
  gameId: string;
  concepts: OntologyConceptInput[];
  relations: OntologyRelationInput[];
}

function optionalConfig(config: ConfigService, key: string, fallback: string): string {
  const value = config.get<string>(key);
  return value === undefined || value === '' ? fallback : value;
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

function nowIso(): string {
  return new Date().toISOString();
}

function conceptRow(entity: unknown): Record<string, unknown> {
  const row = properties(entity);
  return {
    id: String(row.id ?? ''),
    game_id: String(row.gameId ?? ''),
    slug: String(row.slug ?? ''),
    kind: String(row.kind ?? ''),
    title: String(row.title ?? ''),
    synonyms: toStringArray(row.synonyms),
    fact: String(row.fact ?? ''),
    weight: toNumber(row.weight, 1),
    origin: row.origin === 'extracted' ? 'extracted' : 'authored',
    source_document_id: optionalString(row.sourceDocumentId),
    created_at: toDate(row.createdAt),
    updated_at: toDate(row.updatedAt),
  };
}

function relationRow(entity: unknown, fromSlug: unknown, toSlug: unknown): Record<string, unknown> {
  const row = properties(entity);
  return {
    id: String(row.id ?? ''),
    game_id: String(row.gameId ?? ''),
    from_slug: String(fromSlug ?? ''),
    to_slug: String(toSlug ?? ''),
    relation: String(row.relation ?? ''),
    weight: toNumber(row.weight, 1),
    condition: parseCondition(row.conditionJson ?? row.condition),
    note: String(row.note ?? ''),
    origin: row.origin === 'extracted' ? 'extracted' : 'authored',
    source_document_id: optionalString(row.sourceDocumentId),
    created_at: toDate(row.createdAt),
    updated_at: toDate(row.updatedAt),
  };
}

function communityRow(entity: unknown): Record<string, unknown> {
  const row = properties(entity);
  return {
    id: String(row.id ?? ''),
    game_id: String(row.gameId ?? ''),
    level: toNumber(row.level, 0),
    title: String(row.title ?? ''),
    summary: String(row.summary ?? ''),
    member_slugs: toStringArray(row.memberSlugs),
    created_at: toDate(row.createdAt),
    updated_at: toDate(row.updatedAt),
  };
}

@Injectable()
export class Neo4jService implements OnModuleDestroy {
  private readonly driver: Driver;
  private readonly database: string;

  constructor(config: ConfigService) {
    const uri = optionalConfig(config, 'NEO4J_URI', 'bolt://localhost:7687');
    const user = optionalConfig(config, 'NEO4J_USER', 'neo4j');
    const password = optionalConfig(config, 'NEO4J_PASSWORD', 'neo4j_password');
    this.database = optionalConfig(config, 'NEO4J_DATABASE', 'neo4j');
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  // Миграции Neo4j больше не выполняются при инициализации модуля (issue #336).
  // Constraints/indexes раскатывает версионный раннер из `@tg-games/core/db`
  // (см. `packages/core/src/db/migrations/registry.ts`, миграция
  // `0001_baseline_constraints_and_indexes`). Запускается отдельным шагом
  // `npm run migrate` или one-shot сервисом `migrate` в docker-compose.

  async onModuleDestroy(): Promise<void> {
    await this.driver.close();
  }

  private session(mode: 'READ' | 'WRITE'): Session {
    return this.driver.session({
      database: this.database,
      defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
    });
  }

  private async read<T>(work: (tx: Neo4jQueryRunner) => Promise<T>): Promise<T> {
    const session = this.session('READ');
    try {
      return await session.executeRead((tx: ManagedTransaction) => work(tx));
    } finally {
      await session.close();
    }
  }

  private async write<T>(work: (tx: Neo4jQueryRunner) => Promise<T>): Promise<T> {
    const session = this.session('WRITE');
    try {
      return await session.executeWrite((tx: ManagedTransaction) => work(tx));
    } finally {
      await session.close();
    }
  }

  async getGameOntology(gameId: string): Promise<{ concepts: Record<string, unknown>[]; relations: Record<string, unknown>[] }> {
    return await this.read(async (tx) => {
      const concepts = await tx.run(
        `
        MATCH (c:OntologyConcept {gameId: $gameId})
        RETURN c
        ORDER BY c.weight DESC, c.title ASC
        `,
        { gameId },
      );
      const relations = await tx.run(
        `
        MATCH (from:OntologyConcept {gameId: $gameId})-[r:ONTOLOGY_RELATION {gameId: $gameId}]->(to:OntologyConcept {gameId: $gameId})
        RETURN r, from.slug AS fromSlug, to.slug AS toSlug
        ORDER BY from.slug ASC, to.slug ASC, r.relation ASC
        `,
        { gameId },
      );
      return {
        concepts: concepts.records.map((record) => conceptRow(record.get('c'))),
        relations: relations.records.map((record) =>
          relationRow(record.get('r'), record.get('fromSlug'), record.get('toSlug')),
        ),
      };
    });
  }

  async getGameCommunities(gameId: string): Promise<Record<string, unknown>[]> {
    return await this.read(async (tx) => {
      const result = await tx.run(
        `
        MATCH (c:GraphCommunity {gameId: $gameId})
        RETURN c
        ORDER BY c.level ASC, c.title ASC
        `,
        { gameId },
      );
      return result.records.map((record) => communityRow(record.get('c')));
    });
  }

  async verifyOntologyConcept(id: string): Promise<Record<string, unknown> | null> {
    const updated = await this.write(async (tx) => {
      const result = await tx.run(
        `
        MATCH (c:OntologyConcept {id: $id, origin: 'extracted'})
        SET c.origin = 'authored', c.updatedAt = $now
        RETURN c
        `,
        { id, now: nowIso() },
      );
      return result.records[0] ? conceptRow(result.records[0].get('c')) : null;
    });
    if (updated) return updated;
    return await this.read(async (tx) => {
      const result = await tx.run('MATCH (c:OntologyConcept {id: $id}) RETURN c', { id });
      return result.records[0] ? conceptRow(result.records[0].get('c')) : null;
    });
  }

  async verifyOntologyRelation(id: string): Promise<Record<string, unknown> | null> {
    const updated = await this.write(async (tx) => {
      const result = await tx.run(
        `
        MATCH (from:OntologyConcept)-[r:ONTOLOGY_RELATION {id: $id, origin: 'extracted'}]->(to:OntologyConcept)
        SET r.origin = 'authored', r.updatedAt = $now
        RETURN r, from.slug AS fromSlug, to.slug AS toSlug
        `,
        { id, now: nowIso() },
      );
      return result.records[0]
        ? relationRow(result.records[0].get('r'), result.records[0].get('fromSlug'), result.records[0].get('toSlug'))
        : null;
    });
    if (updated) return updated;
    return await this.read(async (tx) => {
      const result = await tx.run(
        'MATCH (from:OntologyConcept)-[r:ONTOLOGY_RELATION {id: $id}]->(to:OntologyConcept) RETURN r, from.slug AS fromSlug, to.slug AS toSlug',
        { id },
      );
      return result.records[0]
        ? relationRow(result.records[0].get('r'), result.records[0].get('fromSlug'), result.records[0].get('toSlug'))
        : null;
    });
  }

  async createOntologyConcept(gameId: string, input: OntologyConceptInput): Promise<Record<string, unknown>> {
    const row = await this.write(async (tx) => {
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
          slug: input.slug,
          kind: input.kind,
          title: input.title,
          synonyms: input.synonyms ?? [],
          fact: input.fact ?? '',
          weight: input.weight ?? 1.0,
          now: nowIso(),
        },
      );
      return result.records[0] ? conceptRow(result.records[0].get('c')) : null;
    });
    if (!row) throw new Neo4jOntologyConflictError(`Концепт «${input.slug}» уже существует в этой игре`);
    return row;
  }

  async updateOntologyConcept(id: string, input: OntologyConceptInput): Promise<Record<string, unknown> | null> {
    const result = await this.write(async (tx) => {
      const res = await tx.run(
        `
        MATCH (c:OntologyConcept {id: $id})
        OPTIONAL MATCH (dup:OntologyConcept {slug: $slug})
        WHERE dup.gameId = c.gameId AND dup.id <> c.id
        WITH c, dup
        RETURN c, dup IS NOT NULL AS duplicate
        `,
        { id, slug: input.slug },
      );
      if (!res.records[0]) return { row: null, duplicate: false };
      if (res.records[0].get('duplicate') === true) return { row: null, duplicate: true };
      const update = await tx.run(
        `
        MATCH (c:OntologyConcept {id: $id})
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
      return {
        row: update.records[0] ? conceptRow(update.records[0].get('c')) : null,
        duplicate: false,
      };
    });
    if (result.duplicate) throw new Neo4jOntologyConflictError(`Концепт «${input.slug}» уже существует в этой игре`);
    return result.row;
  }

  async deleteOntologyConcept(id: string): Promise<string | null> {
    return await this.write(async (tx) => {
      const result = await tx.run(
        `
        MATCH (c:OntologyConcept {id: $id})
        WITH c, c.id AS id
        DETACH DELETE c
        RETURN id
        `,
        { id },
      );
      return result.records[0] ? String(result.records[0].get('id')) : null;
    });
  }

  async createOntologyRelation(gameId: string, input: OntologyRelationInput): Promise<Record<string, unknown>> {
    const row = await this.write(async (tx) => {
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
        ? relationRow(result.records[0].get('r'), result.records[0].get('fromSlug'), result.records[0].get('toSlug'))
        : null;
    });
    if (!row) throw new Neo4jOntologyConflictError('Такая связь уже существует или её концепты не найдены');
    return row;
  }

  async updateOntologyRelation(id: string, input: OntologyRelationInput): Promise<Record<string, unknown> | null> {
    const result = await this.write(async (tx) => {
      const existing = await tx.run(
        `
        MATCH ()-[old:ONTOLOGY_RELATION {id: $id}]->()
        RETURN old.gameId AS gameId,
               old.createdAt AS createdAt,
               old.sourceDocumentId AS sourceDocumentId,
               old.origin AS origin
        `,
        { id },
      );
      const existingRecord = existing.records[0];
      if (!existingRecord) return { row: null, conflict: false };

      const gameId = String(existingRecord.get('gameId') ?? '');
      const endpoints = await tx.run(
        `
        MATCH (from:OntologyConcept {gameId: $gameId, slug: $fromSlug})
        MATCH (to:OntologyConcept {gameId: $gameId, slug: $toSlug})
        RETURN from, to
        `,
        { gameId, fromSlug: input.fromSlug, toSlug: input.toSlug },
      );
      if (!endpoints.records[0]) return { row: null, conflict: true };

      const duplicate = await tx.run(
        `
        MATCH (from:OntologyConcept {gameId: $gameId, slug: $fromSlug})
              -[dup:ONTOLOGY_RELATION {gameId: $gameId, relation: $relation}]->
              (to:OntologyConcept {gameId: $gameId, slug: $toSlug})
        WHERE dup.id <> $id
        RETURN dup
        LIMIT 1
        `,
        {
          gameId,
          id,
          fromSlug: input.fromSlug,
          toSlug: input.toSlug,
          relation: input.relation,
        },
      );
      if (duplicate.records.length > 0) return { row: null, conflict: true };

      const result = await tx.run(
        `
        MATCH ()-[old:ONTOLOGY_RELATION {id: $id}]->()
        MATCH (from:OntologyConcept {gameId: $gameId, slug: $fromSlug})
        MATCH (to:OntologyConcept {gameId: $gameId, slug: $toSlug})
        DELETE old
        CREATE (from)-[r:ONTOLOGY_RELATION {
          id: $id,
          gameId: $gameId,
          relation: $relation,
          weight: $weight,
          note: $note,
          origin: $origin,
          createdAt: $createdAt,
          updatedAt: $now
        }]->(to)
        SET r.conditionJson = $conditionJson,
            r.sourceDocumentId = $sourceDocumentId
        RETURN r, from.slug AS fromSlug, to.slug AS toSlug
        `,
        {
          id,
          gameId,
          fromSlug: input.fromSlug,
          toSlug: input.toSlug,
          relation: input.relation,
          weight: input.weight ?? 1.0,
          conditionJson: input.condition ? JSON.stringify(input.condition) : null,
          note: input.note ?? '',
          origin: existingRecord.get('origin') ?? 'authored',
          createdAt: existingRecord.get('createdAt') ?? nowIso(),
          sourceDocumentId: existingRecord.get('sourceDocumentId') ?? null,
          now: nowIso(),
        },
      );
      return {
        row: result.records[0]
          ? relationRow(result.records[0].get('r'), result.records[0].get('fromSlug'), result.records[0].get('toSlug'))
          : null,
        conflict: false,
      };
    });
    if (result.conflict) throw new Neo4jOntologyConflictError('Такая связь уже существует или её концепты не найдены');
    return result.row;
  }

  async deleteOntologyRelation(id: string): Promise<string | null> {
    return await this.write(async (tx) => {
      const result = await tx.run(
        `
        MATCH ()-[r:ONTOLOGY_RELATION {id: $id}]->()
        WITH r, r.id AS id
        DELETE r
        RETURN id
        `,
        { id },
      );
      return result.records[0] ? String(result.records[0].get('id')) : null;
    });
  }

  async exportGameOntology(gameId: string): Promise<{
    concepts: Record<string, unknown>[];
    relations: Record<string, unknown>[];
  }> {
    const graph = await this.getGameOntology(gameId);
    return {
      concepts: [...graph.concepts].sort((a, b) =>
        Number(b.weight ?? 0) - Number(a.weight ?? 0) || String(a.slug).localeCompare(String(b.slug)),
      ),
      relations: [...graph.relations].sort((a, b) =>
        String(a.from_slug).localeCompare(String(b.from_slug)) ||
        String(a.to_slug).localeCompare(String(b.to_slug)) ||
        String(a.relation).localeCompare(String(b.relation)),
      ),
    };
  }

  async importGameOntology(payload: OntologyImportPayload): Promise<{ created: number; updated: number }> {
    return await this.write(async (tx) => {
      let created = 0;
      let updated = 0;
      for (const c of payload.concepts) {
        const existing = await tx.run(
          'MATCH (c:OntologyConcept {gameId: $gameId, slug: $slug}) RETURN c',
          { gameId: payload.gameId, slug: c.slug },
        );
        if (existing.records.length === 0) {
          await tx.run(
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
            `,
            {
              gameId: payload.gameId,
              slug: c.slug,
              kind: c.kind,
              title: c.title,
              synonyms: c.synonyms ?? [],
              fact: c.fact ?? '',
              weight: c.weight ?? 1.0,
              now: nowIso(),
            },
          );
          created += 1;
        } else {
          await tx.run(
            `
            MATCH (c:OntologyConcept {gameId: $gameId, slug: $slug})
            SET c.kind = $kind,
                c.title = $title,
                c.synonyms = $synonyms,
                c.fact = $fact,
                c.weight = $weight,
                c.updatedAt = $now
            `,
            {
              gameId: payload.gameId,
              slug: c.slug,
              kind: c.kind,
              title: c.title,
              synonyms: c.synonyms ?? [],
              fact: c.fact ?? '',
              weight: c.weight ?? 1.0,
              now: nowIso(),
            },
          );
          updated += 1;
        }
      }
      for (const r of payload.relations) {
        const existing = await tx.run(
          `
          MATCH (from:OntologyConcept {gameId: $gameId, slug: $fromSlug})-[r:ONTOLOGY_RELATION {gameId: $gameId, relation: $relation}]->(to:OntologyConcept {gameId: $gameId, slug: $toSlug})
          RETURN r
          `,
          {
            gameId: payload.gameId,
            fromSlug: r.fromSlug,
            toSlug: r.toSlug,
            relation: r.relation,
          },
        );
        if (existing.records.length === 0) {
          await tx.run(
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
            `,
            {
              gameId: payload.gameId,
              fromSlug: r.fromSlug,
              toSlug: r.toSlug,
              relation: r.relation,
              weight: r.weight ?? 1.0,
              conditionJson: r.condition ? JSON.stringify(r.condition) : null,
              note: r.note ?? '',
              now: nowIso(),
            },
          );
          created += 1;
        } else {
          await tx.run(
            `
            MATCH (from:OntologyConcept {gameId: $gameId, slug: $fromSlug})-[r:ONTOLOGY_RELATION {gameId: $gameId, relation: $relation}]->(to:OntologyConcept {gameId: $gameId, slug: $toSlug})
            SET r.weight = $weight,
                r.conditionJson = $conditionJson,
                r.note = $note,
                r.updatedAt = $now
            `,
            {
              gameId: payload.gameId,
              fromSlug: r.fromSlug,
              toSlug: r.toSlug,
              relation: r.relation,
              weight: r.weight ?? 1.0,
              conditionJson: r.condition ? JSON.stringify(r.condition) : null,
              note: r.note ?? '',
              now: nowIso(),
            },
          );
          updated += 1;
        }
      }
      return { created, updated };
    });
  }
}
