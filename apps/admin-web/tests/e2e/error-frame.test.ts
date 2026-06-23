import { expect, test } from '@playwright/test';

// Перехват ошибок интерфейса (issue #230): необработанная ошибка не должна
// «ронять» приложение в белый экран — её ловит корневая граница и показывает
// красивую рамку с отчётом, готовым к копированию в задачу на доработку.
test('необработанная ошибка окна показывается в красивой рамке с отчётом', async ({ page }) => {
  await page.goto('/');
  // Дожидаемся монтирования приложения: корневая граница уже слушает window error.
  await expect(page.locator('#root')).not.toBeEmpty();

  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new Error('Тестовая ошибка #185'),
        message: 'Тестовая ошибка #185',
      }),
    );
  });

  const frame = page.locator('.error-frame');
  await expect(frame).toBeVisible();
  await expect(frame.locator('.error-frame-title')).toHaveText('Ошибка интерфейса');
  await expect(frame.locator('.error-frame-message')).toContainText('Тестовая ошибка #185');

  // Отчёт в текстовом поле — это готовый к копированию Markdown.
  const report = frame.locator('.error-frame-report');
  await expect(report).toHaveValue(/## Ошибка интерфейса/);
  await expect(report).toHaveValue(/Тестовая ошибка #185/);

  // «Продолжить работу» закрывает оверлей, приложение остаётся живым.
  await frame.getByRole('button', { name: 'Продолжить работу' }).click();
  await expect(frame).toHaveCount(0);
  await expect(page.locator('#root')).not.toBeEmpty();
});
