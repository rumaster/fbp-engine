import { describe, expect, it } from 'vitest';
import { buildLlmRequestLogInputs } from '@tg-games/core/db/repositories/llmLogs.js';
import type { LLMCallLogEntry } from '@tg-games/core/llm/trace.js';

describe('buildLlmRequestLogInputs (#83)', () => {
  it('строит строки аудита с провайдером, моделью, параметрами, токенами и стоимостью', () => {
    const entries: LLMCallLogEntry[] = [
      {
        kind: 'narrative_generation',
        request: 'Промпт:\nсцена',
        response: '{"narrative":"ok"}',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        modelParams: { jsonMode: true, hasSystemInstruction: true, cacheKey: 'sess-1' },
      },
    ];

    const rows = buildLlmRequestLogInputs(entries, {
      userId: 'user-1',
      sessionId: 'sess-1',
      stepId: 'step-1',
      provider: 'Google',
      model: 'gemini-1.5-flash',
      modelParams: { temperature: 0.7, maxRetries: 3 },
      pricing: { input: 1, output: 4, cacheRead: 0, cacheCreation: 0 },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        sessionId: 'sess-1',
        stepId: 'step-1',
        requestKind: 'narrative_generation',
        provider: 'Google',
        model: 'gemini-1.5-flash',
        requestText: 'Промпт:\nсцена',
        responseText: '{"narrative":"ok"}',
        errorText: null,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        costMillicents: 18,
      }),
    ]);
    expect(rows[0].modelParams).toMatchObject({
      temperature: 0.7,
      maxRetries: 3,
      jsonMode: true,
      hasSystemInstruction: true,
      cacheKey: 'sess-1',
    });
  });

  it('сохраняет ошибку отдельным полем и не кладёт её в responseText', () => {
    const rows = buildLlmRequestLogInputs(
      [
        {
          kind: 'support_consultation',
          request: 'Промпт:\nдиалог',
          response: 'Ошибка: rate limit',
          error: 'rate limit',
        },
      ],
      {
        userId: 'user-1',
        supportTicketId: 'ticket-1',
        provider: 'OpenAI',
        model: 'gpt-4o-mini',
        pricing: null,
      },
    );

    expect(rows[0]).toMatchObject({
      requestKind: 'support_consultation',
      responseText: null,
      errorText: 'rate limit',
      costMillicents: 0,
    });
  });

  it('поддерживает медиа-запросы как такие же строки аудита', () => {
    const rows = buildLlmRequestLogInputs(
      [
        {
          kind: 'media_image',
          request: 'Провайдер: OpenAI (иллюстрация)\nПромпт: сцена',
          response: 'Изображение png, 100 байт.',
          usage: { promptTokens: 30, completionTokens: 70, totalTokens: 100 },
          modelParams: { size: '1024x1024' },
        },
      ],
      {
        userId: 'user-1',
        sessionId: 'sess-1',
        stepId: 'step-1',
        provider: 'OpenAI',
        model: 'gpt-image-1',
        pricing: null,
      },
    );

    expect(rows[0]).toMatchObject({
      requestKind: 'media_image',
      provider: 'OpenAI',
      model: 'gpt-image-1',
      tokenUsage: {
        inputTokens: 30,
        outputTokens: 70,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      costMillicents: 0,
    });
    expect(rows[0].modelParams).toMatchObject({ size: '1024x1024' });
  });
});
