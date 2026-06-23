import { Telegram } from 'telegraf';
import { loadConfig } from '@tg-games/core/config.js';
import { closePool } from '@tg-games/core/db/pool.js';
import { createDefaultEmbeddingProvider, createLLMProvider } from '@tg-games/core/llm/factory.js';
import { createClientSupportBot } from './bot.js';

/**
 * Точка входа клиентского бота службы поддержки (issue #57).
 *
 * Бот принимает сообщения клиентов, складывает их в обращения и уведомляет
 * администраторов о новых обращениях через бот администраторов. Для рассылки
 * уведомлений создаётся отдельный Telegram-клиент с токеном бота администраторов.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.support.clientBotToken) {
    throw new Error('Не задан SUPPORT_BOT_TOKEN — токен клиентского бота поддержки');
  }
  if (!config.support.adminBotToken) {
    throw new Error('Не задан SUPPORT_ADMIN_BOT_TOKEN — токен бота администраторов для уведомлений');
  }

  // Миграции БД отвязаны от бота (issue #336) — применяет отдельный шаг
  // `npm run migrate` / сервис `migrate` в docker-compose.

  // Клиент API бота администраторов — через него рассылаем уведомления админам.
  const adminNotifier = new Telegram(config.support.adminBotToken);
  // LLM-провайдер для бота-консультанта первой линии (issue #59).
  const provider = config.support.llmConsultation ? createLLMProvider(config) : undefined;
  // Провайдер эмбеддингов для поиска экспертизы (issue #147, #279). Включается
  // только вместе с консультантом и при полной настройке выбранного провайдера.
  const embeddingProviderFactory = config.support.llmConsultation
    ? async () => (await createDefaultEmbeddingProvider(config)) ?? undefined
    : undefined;
  const bot = createClientSupportBot(config, { adminNotifier, provider, embeddingProviderFactory });
  if (provider) {
    console.log(`🤖 Бот СП использует LLM-провайдер: ${provider.name}`);
  }
  const embeddingProvider = await embeddingProviderFactory?.();
  if (embeddingProvider) {
    console.log(`🔎 Поиск экспертизы включён (эмбеддинги: ${embeddingProvider.model})`);
  }

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Связаться со службой поддержки' },
  ]);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal}: останавливаю бот поддержки...`);
    bot.stop(signal);
    await closePool();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.launch(() => console.log('✅ Клиентский бот поддержки запущен'));
}

main().catch((err) => {
  console.error('❌ Фатальная ошибка при запуске бота поддержки:', err);
  process.exit(1);
});
