# syntax=docker/dockerfile:1.7

# Этап 1: Сборка TypeScript (монорепо npm workspaces)
FROM node:20-alpine AS builder
WORKDIR /app
# Корневой манифест, lock-файл и манифесты воркспейсов нужны до npm ci, чтобы
# npm проставил симлинки локальных пакетов (@tg-games/core, @tg-games/schema-contract).
# До npm ci копируются только package.json-файлы workspace-пакетов: этого
# достаточно для корректных симлинков, а слой установки зависимостей не
# инвалидируется при каждом изменении исходников (issue #377).
# Манифесты apps/admin-api и apps/admin-web НЕ копируются: образу нужен только
# игровой бот. Без них npm ci не тянет тяжёлые зависимости админки (NestJS, React,
# Vite, Playwright) — установка ~180 МБ вместо ~270 МБ, что устраняет переполнение
# диска (ENOSPC) при сборке (issue #366).
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/schema-contract/package.json ./packages/schema-contract/package.json
COPY apps/bot/package.json ./apps/bot/package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci
# Исходники и общий tsconfig. Собираем ядро, затем игровой бот.
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/schema-contract ./packages/schema-contract
COPY apps/bot ./apps/bot
RUN npm run build

# Этап 2: Запуск готового кода
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/schema-contract/package.json ./packages/schema-contract/package.json
COPY apps/bot/package.json ./apps/bot/package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --omit=dev
# Runtime-файлы schema-contract нужны по workspace-симлинку из node_modules.
COPY packages/schema-contract ./packages/schema-contract
# Собранные артефакты ядра (включая dist/db/schema.sql) и бота из стадии builder.
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/apps/bot/dist ./apps/bot/dist

CMD ["node", "apps/bot/dist/index.js"]
