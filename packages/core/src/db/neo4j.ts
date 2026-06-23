import neo4j, {
  type Driver,
  type ManagedTransaction,
  type QueryResult,
  type Session,
} from 'neo4j-driver';
import { loadConfig } from '../config.js';

export interface Neo4jQueryRunner {
  run<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<QueryResult<T>>;
}

let driver: Driver | null = null;

function getNeo4jDriver(): Driver {
  if (!driver) {
    const { neo4j: config } = loadConfig();
    driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
  }
  return driver;
}

function getSession(mode: 'READ' | 'WRITE'): Session {
  const { neo4j: config } = loadConfig();
  return getNeo4jDriver().session({
    database: config.database,
    defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
  });
}

export async function runNeo4jRead<T>(
  work: (tx: Neo4jQueryRunner) => Promise<T>,
): Promise<T> {
  const session = getSession('READ');
  try {
    return await session.executeRead((tx: ManagedTransaction) => work(tx));
  } finally {
    await session.close();
  }
}

export async function runNeo4jWrite<T>(
  work: (tx: Neo4jQueryRunner) => Promise<T>,
): Promise<T> {
  const session = getSession('WRITE');
  try {
    return await session.executeWrite((tx: ManagedTransaction) => work(tx));
  } finally {
    await session.close();
  }
}

export async function migrateNeo4j(): Promise<void> {
  await runNeo4jWrite(async (tx) => {
    await tx.run(`
      CREATE CONSTRAINT ontology_concept_id IF NOT EXISTS
      FOR (c:OntologyConcept) REQUIRE c.id IS UNIQUE
    `);
    await tx.run(`
      CREATE CONSTRAINT ontology_concept_game_slug IF NOT EXISTS
      FOR (c:OntologyConcept) REQUIRE (c.gameId, c.slug) IS UNIQUE
    `);
    await tx.run(`
      CREATE CONSTRAINT ontology_relation_id IF NOT EXISTS
      FOR ()-[r:ONTOLOGY_RELATION]-() REQUIRE r.id IS UNIQUE
    `);
    await tx.run(`
      CREATE CONSTRAINT graph_community_id IF NOT EXISTS
      FOR (c:GraphCommunity) REQUIRE c.id IS UNIQUE
    `);
    await tx.run(`
      CREATE INDEX graph_community_game IF NOT EXISTS
      FOR (c:GraphCommunity) ON (c.gameId)
    `);
  });
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
