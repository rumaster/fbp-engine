#!/usr/bin/env bash
# Очищает PostgreSQL базу tg-games перед прогоном миграций (issue #336).
#
# Поведение:
#   - DROP SCHEMA public CASCADE;
#   - CREATE SCHEMA public;
#   - выдача прав владельцу (по умолчанию — пользователь подключения).
#
# Дополнительно удаляются объекты pgvector в схеме public (расширение
# пересоздаётся baseline-миграцией). schema_migrations тоже удаляется,
# поэтому раннер заново применит baseline (нужно при свежей раскатке).
#
# Использование:
#   scripts/db/clean.sh                # с подтверждением
#   scripts/db/clean.sh --force        # без подтверждения (для CI/тестов)
#
# Переменные окружения: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.

set -euo pipefail
. "$(dirname "$0")/_lib.sh"

require_bin psql

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    *)
      log "Неизвестный аргумент: $arg"
      exit 2
      ;;
  esac
done

if [ "$FORCE" -ne 1 ]; then
  printf '[db] Это удалит все данные в %s@%s:%s. Продолжить? [y/N] ' \
    "$DB_NAME" "$DB_HOST" "$DB_PORT" >&2
  read -r answer
  case "$answer" in
    y|Y|yes|YES) : ;;
    *)
      log "Отменено."
      exit 1
      ;;
  esac
fi

log "Очищаю схему public в ${DB_NAME}@${DB_HOST}:${DB_PORT}"
psql \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --set=ON_ERROR_STOP=1 \
  --quiet \
  <<SQL
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO "$DB_USER";
GRANT ALL ON SCHEMA public TO public;
SQL

log "Готово: схема public пересоздана."
