// Baseline-ограничения и индексы графа онтологии (issue #336, О4).
//
// Извлечено из inline-Cypher реестра миграций в версионный файл, чтобы
// структура подсистемы БД была единообразной (см. cypher/README.md). Реестр
// читает этот файл и выполняет операторы по одному (Neo4j tx.run принимает
// ровно один statement за вызов), разделяя их по `;`.

CREATE CONSTRAINT ontology_concept_id IF NOT EXISTS
FOR (c:OntologyConcept) REQUIRE c.id IS UNIQUE;

CREATE CONSTRAINT ontology_concept_game_slug IF NOT EXISTS
FOR (c:OntologyConcept) REQUIRE (c.gameId, c.slug) IS UNIQUE;

CREATE CONSTRAINT ontology_relation_id IF NOT EXISTS
FOR ()-[r:ONTOLOGY_RELATION]-() REQUIRE r.id IS UNIQUE;

CREATE CONSTRAINT graph_community_id IF NOT EXISTS
FOR (c:GraphCommunity) REQUIRE c.id IS UNIQUE;

CREATE INDEX graph_community_game IF NOT EXISTS
FOR (c:GraphCommunity) ON (c.gameId);
