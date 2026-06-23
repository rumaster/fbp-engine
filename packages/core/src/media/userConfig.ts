import type { AppConfig, LLMProviderName } from '../config.js';

export type MediaConfigSubject = 'tts' | 'image';

export interface MediaSelectOption {
  id: string;
  label: string;
}

export interface TtsModelOption extends MediaSelectOption {
  voices: MediaSelectOption[];
}

export interface ImageModelOption extends MediaSelectOption {
  sizes: MediaSelectOption[];
}

export interface MediaProviderUserOptions {
  provider: LLMProviderName;
  tts: {
    models: TtsModelOption[];
  };
  image: {
    models: ImageModelOption[];
  };
}

export interface UserMediaConfigValues {
  ttsModel?: string | null;
  ttsVoice?: string | null;
  imageModel?: string | null;
  imageSize?: string | null;
}

export interface EffectiveMediaConfig {
  tts: {
    model: string;
    voice: string;
  };
  image: {
    model: string;
    size: string;
  };
}

const OPENAI_TTS_VOICES: MediaSelectOption[] = [
  'alloy',
  'ash',
  'ballad',
  'cedar',
  'coral',
  'echo',
  'fable',
  'marin',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
].map((id) => ({ id, label: id }));

const OPENAI_LEGACY_TTS_VOICES: MediaSelectOption[] = [
  'alloy',
  'ash',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
].map((id) => ({ id, label: id }));

const GOOGLE_TTS_VOICES: MediaSelectOption[] = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
].map((id) => ({ id, label: id }));

const OPENAI_GPT_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'].map(option);
const GOOGLE_IMAGEN_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'].map(option);

const GOOGLE_TTS_MODELS: TtsModelOption[] = [
  {
    id: 'gemini-3.1-flash-tts-preview',
    label: 'gemini-3.1-flash-tts-preview',
    voices: GOOGLE_TTS_VOICES,
  },
  {
    id: 'gemini-2.5-flash-preview-tts',
    label: 'gemini-2.5-flash-preview-tts',
    voices: GOOGLE_TTS_VOICES,
  },
  {
    id: 'gemini-2.5-pro-preview-tts',
    label: 'gemini-2.5-pro-preview-tts',
    voices: GOOGLE_TTS_VOICES,
  },
];

const GOOGLE_IMAGE_MODELS: ImageModelOption[] = [
  {
    id: 'imagen-4.0-generate-001',
    label: 'imagen-4.0-generate-001',
    sizes: GOOGLE_IMAGEN_ASPECT_RATIOS,
  },
  {
    id: 'imagen-4.0-ultra-generate-001',
    label: 'imagen-4.0-ultra-generate-001',
    sizes: GOOGLE_IMAGEN_ASPECT_RATIOS,
  },
  {
    id: 'imagen-4.0-fast-generate-001',
    label: 'imagen-4.0-fast-generate-001',
    sizes: GOOGLE_IMAGEN_ASPECT_RATIOS,
  },
  {
    id: 'imagen-3.0-generate-002',
    label: 'imagen-3.0-generate-002',
    sizes: GOOGLE_IMAGEN_ASPECT_RATIOS,
  },
];

const MEDIA_OPTIONS: Partial<Record<LLMProviderName, MediaProviderUserOptions>> = {
  OPENAI: {
    provider: 'OPENAI',
    tts: {
      models: [
        { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts', voices: OPENAI_TTS_VOICES },
        { id: 'tts-1', label: 'tts-1', voices: OPENAI_LEGACY_TTS_VOICES },
        { id: 'tts-1-hd', label: 'tts-1-hd', voices: OPENAI_LEGACY_TTS_VOICES },
      ],
    },
    image: {
      models: [
        {
          id: 'gpt-image-1.5',
          label: 'gpt-image-1.5',
          sizes: OPENAI_GPT_IMAGE_SIZES,
        },
        {
          id: 'gpt-image-1',
          label: 'gpt-image-1',
          sizes: OPENAI_GPT_IMAGE_SIZES,
        },
        {
          id: 'gpt-image-1-mini',
          label: 'gpt-image-1-mini',
          sizes: OPENAI_GPT_IMAGE_SIZES,
        },
        {
          id: 'dall-e-3',
          label: 'dall-e-3',
          sizes: ['1024x1024', '1792x1024', '1024x1792'].map(option),
        },
        {
          id: 'dall-e-2',
          label: 'dall-e-2',
          sizes: ['256x256', '512x512', '1024x1024'].map(option),
        },
      ],
    },
  },
  GOOGLE: {
    provider: 'GOOGLE',
    tts: {
      models: GOOGLE_TTS_MODELS,
    },
    image: {
      models: GOOGLE_IMAGE_MODELS,
    },
  },
};

export function mediaOptionsForProvider(
  provider: LLMProviderName,
): MediaProviderUserOptions | null {
  return MEDIA_OPTIONS[provider] ?? null;
}

export function findTtsModelOption(
  provider: LLMProviderName,
  model: string | null | undefined,
): TtsModelOption | undefined {
  if (!model) return undefined;
  return mediaOptionsForProvider(provider)?.tts.models.find((option) => option.id === model);
}

export function findImageModelOption(
  provider: LLMProviderName,
  model: string | null | undefined,
): ImageModelOption | undefined {
  if (!model) return undefined;
  return mediaOptionsForProvider(provider)?.image.models.find((option) => option.id === model);
}

export function resolveEffectiveMediaConfig(
  media: AppConfig['media'],
  userConfig: UserMediaConfigValues | null | undefined,
): EffectiveMediaConfig {
  const envConfig = {
    tts: { model: media.tts.model, voice: media.tts.voice },
    image: { model: media.image.model, size: media.image.size },
  };
  if (!hasAnyUserConfig(userConfig)) {
    return envConfig;
  }

  const userTtsModel = findTtsModelOption(media.provider, userConfig?.ttsModel);
  const ttsModel = userTtsModel?.id ?? media.tts.model;
  const ttsModelOption = userTtsModel ?? findTtsModelOption(media.provider, ttsModel);
  const ttsVoice = resolveParam({
    userValue: userConfig?.ttsVoice,
    envValue: media.tts.voice,
    options: ttsModelOption?.voices,
    keepEnvValue: !userTtsModel,
  });

  const userImageModel = findImageModelOption(media.provider, userConfig?.imageModel);
  const imageModel = userImageModel?.id ?? media.image.model;
  const imageModelOption = userImageModel ?? findImageModelOption(media.provider, imageModel);
  const imageSize = resolveParam({
    userValue: userConfig?.imageSize,
    envValue: media.image.size,
    options: imageModelOption?.sizes,
    keepEnvValue: !userImageModel,
  });

  return {
    tts: { model: ttsModel, voice: ttsVoice },
    image: { model: imageModel, size: imageSize },
  };
}

function option(id: string): MediaSelectOption {
  return { id, label: id };
}

function hasAnyUserConfig(config: UserMediaConfigValues | null | undefined): boolean {
  return Boolean(
    config &&
      [config.ttsModel, config.ttsVoice, config.imageModel, config.imageSize].some(hasValue),
  );
}

function hasValue(value: string | null | undefined): value is string {
  return Boolean(value && value.trim());
}

function resolveParam({
  userValue,
  envValue,
  options,
  keepEnvValue,
}: {
  userValue: string | null | undefined;
  envValue: string;
  options: MediaSelectOption[] | undefined;
  keepEnvValue: boolean;
}): string {
  if (options?.some((option) => option.id === userValue)) {
    return userValue as string;
  }
  if (keepEnvValue || options?.some((option) => option.id === envValue)) {
    return envValue;
  }
  return options?.[0]?.id ?? envValue;
}
