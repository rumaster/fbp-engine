#!/usr/bin/env bash
# Восстанавливает PostgreSQL базу tg-games из дампа (issue #336).
#
# По умолчанию восстанавливается только данные (--data-only): схема должна
# быть уже создана версионным раннером миграций. Это исключает конфликт между
# DDL из дампа и актуальной схемой и позволяет переносить дамп между версиями.
#
# Использование:
#   scripts/db/restore.sh path/to/file.dump            # data-only (default)
#   scripts/db/restore.sh path/to/file.dump --full     # схема + данные из дампа
#
# Доп. аргументы прокидываются в pg_restore: --jobs=N, --no-owner, и т.п.

set -euo pipefail
. "$(dirname "$0")/_lib.sh"

require_bin pg_restore

INPUT=""
MODE="data-only"
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --full)        MODE="full" ;;
    --data-only)   MODE="data-only" ;;
    --schema-only) MODE="schema-only" ;;
    --*)           EXTRA_ARGS+=("$arg") ;;
    *)             INPUT="$arg" ;;
  esac
done

if [ -z "$INPUT" ]; then
  log "Не указан путь к дампу. Использование: scripts/db/restore.sh <file.dump> [--full]"
  exit 2
fi
if [ ! -f "$INPUT" ]; then
  log "Файл дампа не найден: $INPUT"
  exit 2
fi

case "$MODE" in
  data-only)
    EXTRA_ARGS=("--data-only" "${EXTRA_ARGS[@]}")
    ;;
  schema-only)
    EXTRA_ARGS=("--schema-only" "${EXTRA_ARGS[@]}")
    ;;
  full)
    : # без флага — pg_restore развернёт схему + данные
    ;;
esac

log "Восстанавливаю (${MODE}) ${INPUT} → ${DB_NAME}@${DB_HOST}:${DB_PORT}"
pg_restore \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --no-owner \
  --no-acl \
  --single-transaction \
  --exit-on-error \
  "${EXTRA_ARGS[@]}" \
  "$INPUT"

log "Готово."
