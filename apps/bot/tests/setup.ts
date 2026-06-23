import { vi } from 'vitest';
import {
  TEST_GAMES,
  listTestGames,
  testGameTitleMap,
} from './fixtures/gameManifests.js';

vi.mock('@tg-games/core/db/repositories/gameManifests.js', () => ({
  countGameManifests: vi.fn(async () => listTestGames().length),
  getGameManifest: vi.fn(async (gameId: string) => TEST_GAMES[gameId] ?? null),
  listGameManifests: vi.fn(async (gameIds?: readonly string[]) => listTestGames(gameIds)),
  listGameManifestsPaged: vi.fn(async (limit: number, offset: number) =>
    listTestGames().slice(offset, offset + limit),
  ),
  getGameManifestMap: vi.fn(async (gameIds: readonly string[]) => {
    const manifests = listTestGames(gameIds);
    return new Map(manifests.map((game) => [game.id, game]));
  }),
  getGameTitleMap: vi.fn(async (gameIds: readonly string[]) => testGameTitleMap(gameIds)),
  updateGameManifest: vi.fn(async (_gameId: string, manifest: (typeof TEST_GAMES)[string]) => manifest),
}));
