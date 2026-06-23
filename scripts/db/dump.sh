#!/usr/bin/env bash
# Создаёт дамп PostgreSQL базы tg-games (issue #336).
#
# Использование:
#   scripts/db/dump.sh                       # → db-dumps/tg_rpg_db-<TS>.dump
#   scripts/db/dump.sh path/to/file.dump     # → указанный путь
#
# Дамп — в формате `custom` (-Fc): сжатый, пригоден для параллельного
# pg_restore и data-only выборки. Опции:
#   --schema-only / --data-only — пробрасываются в pg_dump.
#
# Переменные окружения (см. scripts/db/_lib.sh): DB_HOST, DB_PORT, DB_USER,
# DB_PASSWORD, DB_NAME, DUMP_DIR.

set -euo pipefail
. "$(dirname "$0")/_lib.sh"

require_bin pg_dump

EXTRA_ARGS=()
OUTPUT=""
for arg in "$@"; do
  case "$arg" in
    --schema-only|--data-only|--clean|--if-exists|--no-owner|--no-acl)
      EXTRA_ARGS+=("$arg")
      ;;
    --*)
      EXTRA_ARGS+=("$arg")
      ;;
    *)
      OUTPUT="$arg"
      ;;
  esac
done

if [ -z "$OUTPUT" ]; then
  mkdir -p "$DUMP_DIR"
  # Формируем имя без вызова `date` несколько раз.
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  OUTPUT="$DUMP_DIR/${DB_NAME}-${TS}.dump"
fi

log "Дамп ${DB_NAME}@${DB_HOST}:${DB_PORT} → ${OUTPUT}"
pg_dump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$OUTPUT" \
  "${EXTRA_ARGS[@]}"

log "Готово: $OUTPUT"
