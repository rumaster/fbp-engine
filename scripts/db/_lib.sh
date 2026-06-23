#!/usr/bin/env bash
# Общие переменные и помощники для скриптов дампа/очистки/восстановления БД
# (issue #336). Подключается через `. "$(dirname "$0")/_lib.sh"`.
#
# Источники конфигурации (в порядке убывания приоритета):
#   1. Переменные окружения, уже выставленные в shell;
#   2. Файл `.env` в корне репозитория (если есть);
#   3. Значения по умолчанию для локальной разработки.
#
# Скрипты не привязаны к Docker: pg_dump/pg_restore/psql/cypher-shell должны
# быть доступны в PATH. Для запуска внутри docker compose см. примеры в
# README.md (`docker compose exec postgres_db sh -c '<скрипт>'`).

set -euo pipefail

# Корень репозитория (выше каталога scripts/db).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Подтягиваем .env, не перезатирая уже выставленные переменные. Игнорируем
# комментарии и пустые строки.
if [ -f "$REPO_ROOT/.env" ]; then
  set +u
  while IFS='=' read -r key value; do
    case "$key" in
      ''|'#'*) continue ;;
    esac
    # Снимаем экранирующие кавычки, если они есть.
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    eval "export ${key}=\${${key}:-\$value}" || true
  done <"$REPO_ROOT/.env"
  set -u
fi

# Postgres: значения по умолчанию совпадают с docker-compose.yml.
export DB_HOST="${DB_HOST:-localhost}"
export DB_PORT="${DB_PORT:-5432}"
export DB_USER="${DB_USER:-postgres}"
export DB_PASSWORD="${DB_PASSWORD:-postgres_password}"
export DB_NAME="${DB_NAME:-tg_rpg_db}"

# Передаём пароль в pg_* через стандартный PGPASSWORD.
export PGPASSWORD="$DB_PASSWORD"

# Каталог хранения дампов (по умолчанию — `db-dumps/` в корне репозитория).
export DUMP_DIR="${DUMP_DIR:-$REPO_ROOT/db-dumps}"

# Краткая печать в stderr.
log() {
  printf '[db] %s\n' "$*" >&2
}

# Проверяет наличие исполняемого файла, иначе завершает работу с понятной ошибкой.
require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Не найден исполняемый файл '$1'. Установите PostgreSQL client tools или"
    log "запускайте скрипт через docker compose: см. README.md → раздел «Дамп БД»."
    exit 127
  fi
}

# Применить миграции через `npm run migrate`. Используется в reset.sh.
run_migrations() {
  log "Применяю миграции через 'npm run migrate'..."
  (cd "$REPO_ROOT" && npm run --silent migrate)
}
