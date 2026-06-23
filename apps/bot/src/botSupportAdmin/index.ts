import { Telegram } from 'telegraf';
import { loadConfig } from '@tg-games/core/config.js';
import { closePool } from '@tg-games/core/db/pool.js';
import { setAdminByTelegramId } from '@tg-games/core/db/repositories/users.js';
import { createAdminSupportBot } from './bot.js';

/**
 * Точка входа бота администраторов службы поддержки (issue #57).
 *
 * Бот показывает активные обращения, позволяет открыть обращение и отвечать
 * клиенту. Ответы доставляются через клиентский бот, поэтому для него создаётся
 * отдельный Telegram-клиент с токеном клиентского бота.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.support.adminBotToken) {
    throw new Error('Не задан SUPPORT_ADMIN_BOT_TOKEN — токен бота администраторов');
  }
  if (!config.support.clientBotToken) {
    throw new Error('Не задан SUPPORT_BOT_TOKEN — токен клиентского бота для доставки ответов');
  }

  // Миграции БД отвязаны от бота (issue #336) — применяет отдельный шаг
  // `npm run migrate` / сервис `migrate` в docker-compose.

  // Назначаем стартовых администраторов из SUPPORT_ADMIN_IDS.
  for (const telegramId of config.support.adminIds) {
    await setAdminByTelegramId(telegramId, true);
    console.log(`👤 Администратор назначен: telegram_id=${telegramId}`);
  }

  // Клиент API клиентского бота — через него доставляем ответы клиентам.
  const clientNotifier = new Telegram(config.support.clientBotToken);
  const bot = createAdminSupportBot(config, { clientNotifier });

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Запустить бот администрирования' },
    { command: 'topics', description: 'Список активных обращений' },
    { command: 'users', description: 'Список пользователей и их игр' },
    { command: 'games', description: 'Сценарии, манифесты и группы' },
    { command: 'groups', description: 'Группы доступных сценариев' },
  ]);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal}: останавливаю бот администраторов...`);
    bot.stop(signal);
    await closePool();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.launch(() => console.log('✅ Бот администраторов поддержки запущен'));
}

main().catch((err) => {
  console.error('❌ Фатальная ошибка при запуске бота администраторов:', err);
  process.exit(1);
});
