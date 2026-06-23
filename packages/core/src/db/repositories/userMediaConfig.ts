import { getPool } from '../pool.js';
import type { UserMediaConfigValues } from '../../media/userConfig.js';

export interface UserMediaConfigRow {
  user_id: string;
  tts_model: string | null;
  tts_voice: string | null;
  image_model: string | null;
  image_size: string | null;
  updated_at: Date;
}

export function userMediaConfigValues(
  row: UserMediaConfigRow | null | undefined,
): UserMediaConfigValues | null {
  if (!row) return null;
  return {
    ttsModel: row.tts_model,
    ttsVoice: row.tts_voice,
    imageModel: row.image_model,
    imageSize: row.image_size,
  };
}

export async function getUserMediaConfig(userId: string): Promise<UserMediaConfigRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<UserMediaConfigRow>(
    'SELECT * FROM user_media_configs WHERE user_id = $1',
    [userId],
  );
  return rows[0] ?? null;
}

export async function setUserTtsModel(
  userId: string,
  model: string,
): Promise<UserMediaConfigRow> {
  return upsertUserMediaConfig(userId, 'tts_model', model);
}

export async function setUserTtsVoice(
  userId: string,
  voice: string,
): Promise<UserMediaConfigRow> {
  return upsertUserMediaConfig(userId, 'tts_voice', voice);
}

export async function setUserImageModel(
  userId: string,
  model: string,
): Promise<UserMediaConfigRow> {
  return upsertUserMediaConfig(userId, 'image_model', model);
}

export async function setUserImageSize(
  userId: string,
  size: string,
): Promise<UserMediaConfigRow> {
  return upsertUserMediaConfig(userId, 'image_size', size);
}

async function upsertUserMediaConfig(
  userId: string,
  column: 'tts_model' | 'tts_voice' | 'image_model' | 'image_size',
  value: string,
): Promise<UserMediaConfigRow> {
  const pool = getPool();
  const { rows } = await pool.query<UserMediaConfigRow>(
    `INSERT INTO user_media_configs (user_id, ${column})
     VALUES ($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()
     RETURNING *`,
    [userId, value],
  );
  return rows[0];
}
