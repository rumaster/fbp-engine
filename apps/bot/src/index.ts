import { loadConfig } from '@tg-games/core/config.js';
import { createLLMProvider } from '@tg-games/core/llm/factory.js';
import { createMediaProvider } from '@tg-games/core/media/factory.js';
import { createBot } from './bot/bot.js';
import { closePool } from '@tg-games/core/db/pool.js';
import { closeNeo4j } from '@tg-games/core/db/neo4j.js';
import { seedAzureModelAliases } from '@tg-games/core/db/repositories/azureModels.js';

/**
 * Точка входа приложения: загружает конфиг, создаёт LLM-провайдера и запускает
 * Telegram-бота.
 *
 * Миграции БД больше не вызываются при старте бота (issue #336): схема
 * раскатывается отдельным шагом `npm run migrate` / one-shot сервисом `migrate`
 * в docker-compose.
 *
 * Сидирование примерных данных игры (база знаний, онтология, сообщества графа,
 * переиндексация Graph RAG) тоже убрано со старта (issue #336, О5): это были не
 * данные приложения, а демонстрационная «затравка» игры «Выживание бомжа».
 * Теперь она хранится как пример формата в `packages/core/src/examples/`
 * (`bomjExpertise.ts`, `bomjOntology.ts`) и при необходимости загружается вручную
 * через репозитории ядра, а не при каждом старте бота.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // Синхронизируем алиасы моделей Azure из AZURE_MODELS (issue #120), не
  // перезатирая правки, сделанные прямо в БД. Это операционная настройка
  // (стоимость запроса Azure считается по реальной модели, а не по имени
  // deployment), а не пример данных, поэтому остаётся на стартовом пути.
  if (config.llm.azure?.models) {
    await seedAzureModelAliases(config.llm.azure.models);
  }

  const provider = createLLMProvider(config);
  console.log(`🤖 LLM провайдер: ${provider.name} (${config.llm.modelName})`);

  // Медиа (озвучка/иллюстрации) — необязательно (issue #71). При null кнопки
  // не показываются, текстовая игра работает как прежде.
  const media = createMediaProvider(config);
  if (media) {
    const caps = [media.canSpeak ? 'озвучка' : null, media.canDraw ? 'иллюстрации' : null]
      .filter(Boolean)
      .join(', ');
    console.log(`🎬 Медиа провайдер: ${media.name} (${caps})`);
  } else {
    console.log('🎬 Медиа отключено: кнопки «Озвучить»/«Нарисовать иллюстрацию» не показываются.');
  }

  const bot = createBot(config, provider, media);

  // Настраиваем меню команд бота.
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Начать и зарегистрироваться' },
    { command: 'menu', description: 'Показать меню' },
    { command: 'cancel', description: 'Отменить последний ход' },
    { command: 'help', description: 'Справка' },
  ]);

  // Корректное завершение.
  const shutdown = async (signal: string) => {
    console.log(`\n${signal}: останавливаю бота...`);
    bot.stop(signal);
    await closePool();
    await closeNeo4j();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.launch(() => console.log('✅ Бот запущен'));
}

main().catch((err) => {
  console.error('❌ Фатальная ошибка при запуске:', err);
  process.exit(1);
});
