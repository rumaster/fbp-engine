-- Переработка логов LLM (issue #403).
--
-- Старая категоризация запросов по «типу» (request_kind: подсказка, нарратив,
-- учёт мира и т. д.) относилась к эпохе захардкоженного оркестратора и больше не
-- отражает реальную модель исполнения через Schema Engine. Теперь источник
-- запроса описывается слагом схемы и идентификатором узла.
--
-- Накопленные записи относятся к старой логике и не несут schema_slug/node_id —
-- по условию issue их можно очистить и начать вести лог заново.

DELETE FROM llm_request_logs;

ALTER TABLE llm_request_logs DROP COLUMN IF EXISTS request_kind;

ALTER TABLE llm_request_logs ADD COLUMN IF NOT EXISTS schema_slug VARCHAR(100);
ALTER TABLE llm_request_logs ADD COLUMN IF NOT EXISTS node_id VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_llm_request_logs_schema
    ON llm_request_logs (schema_slug, created_at);
