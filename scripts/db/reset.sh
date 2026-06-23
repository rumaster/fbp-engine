#!/usr/bin/env bash
# Полный цикл переноса тестовых данных через миграции (issue #336):
#   1. Снять дамп текущей БД (только данные);
#   2. Очистить схему public;
#   3. Применить версионный раннер миграций (`npm run migrate`);
#   4. Залить дамп обратно (--data-only).
#
# Это удобный путь для переноса свежих миграций на уже наполненный dev/test
# инстанс: схема перестраивается с нуля, данные остаются.
#
# Использование:
#   scripts/db/reset.sh                  # с подтверждением
#   scripts/db/reset.sh --force          # без подтверждения

set -euo pipefail
. "$(dirname "$0")/_lib.sh"

FORCE=""
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE="--force" ;;
    *)
      log "Неизвестный аргумент: $arg"
      exit 2
      ;;
  esac
done

mkdir -p "$DUMP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="$DUMP_DIR/${DB_NAME}-reset-${TS}.dump"

log "Шаг 1/4: создаю дамп ДАННЫХ перед очисткой → $DUMP_FILE"
"$SCRIPT_DIR/dump.sh" --data-only "$DUMP_FILE"

log "Шаг 2/4: очищаю схему public"
"$SCRIPT_DIR/clean.sh" ${FORCE:-}

log "Шаг 3/4: применяю миграции"
run_migrations

log "Шаг 4/4: восстанавливаю данные из дампа"
"$SCRIPT_DIR/restore.sh" "$DUMP_FILE" --data-only

log "Готово. Дамп сохранён: $DUMP_FILE"
