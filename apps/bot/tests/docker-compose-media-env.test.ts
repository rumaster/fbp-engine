import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Регрессия issue #78: в docker-compose.yml блок `environment` бота явно
 * перечисляет, какие переменные окружения пробрасываются в контейнер. Раньше
 * там не было ни одной MEDIA_* переменной, поэтому настройки из .env
 * (например MEDIA_TTS_VOICE=ballad, MEDIA_IMAGE_MODEL=gpt-image-1-mini) НЕ
 * доходили до приложения, и loadConfig() подставлял дефолты (alloy, dall-e-3).
 *
 * Тест следит за тем, чтобы все MEDIA_* переменные оставались проброшенными.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

const MEDIA_ENV_KEYS = [
  'MEDIA_PROVIDER',
  'MEDIA_ENABLED',
  'MEDIA_API_KEY',
  'MEDIA_TTS_ENABLED',
  'MEDIA_TTS_MODEL',
  'MEDIA_TTS_VOICE',
  'MEDIA_IMAGE_ENABLED',
  'MEDIA_IMAGE_MODEL',
  'MEDIA_IMAGE_SIZE',
];

describe('docker-compose: проброс MEDIA_* в контейнер (issue #78)', () => {
  const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');

  for (const key of MEDIA_ENV_KEYS) {
    it(`пробрасывает ${key} из .env`, () => {
      // Ожидаем строку вида `MEDIA_TTS_VOICE: ${MEDIA_TTS_VOICE...}` в блоке environment.
      const pattern = new RegExp(`${key}:\\s*\\$\\{${key}`);
      expect(compose).toMatch(pattern);
    });
  }
});

const EMBEDDING_ENV_KEYS = [
  'EMBEDDING_PROVIDER',
  'EMBEDDING_MODEL',
  'AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
];

describe('docker-compose: проброс настроек эмбеддингов в контейнер (issue #279)', () => {
  const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');

  for (const key of EMBEDDING_ENV_KEYS) {
    it(`пробрасывает ${key} из .env`, () => {
      const pattern = new RegExp(`${key}:\\s*\\$\\{${key}`);
      expect(compose).toMatch(pattern);
    });
  }
});

const NEO4J_ENV_KEYS = [
  'NEO4J_USER',
  'NEO4J_PASSWORD',
  'NEO4J_DATABASE',
];

describe('docker-compose: Neo4j доступен приложению (issue #363)', () => {
  const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');

  it('поднимает актуальный community-образ Neo4j', () => {
    expect(compose).toContain('image: neo4j:2026.05.0-community');
  });

  it('пробрасывает внутренний Bolt URI в приложение', () => {
    expect(compose).toContain('NEO4J_URI: bolt://neo4j_db:7687');
  });

  for (const key of NEO4J_ENV_KEYS) {
    it(`пробрасывает ${key} из .env`, () => {
      const pattern = new RegExp(`${key}:\\s*\\$\\{${key}`);
      expect(compose).toMatch(pattern);
    });
  }
});
