import { describe, it, expect } from 'vitest';
import type {
  GeminiPart,
  GeminiContent,
  GeminiRequest,
  GeminiResponse,
} from '../../lib/types';

describe('Type definitions (compile-time validation)', () => {
  it('1: GeminiPart can have text only', () => {
    const part: GeminiPart = { text: 'hello' };
    expect(part.text).toBe('hello');
    expect(part.inlineData).toBeUndefined();
  });

  it('2: GeminiPart can have inlineData only', () => {
    const part: GeminiPart = {
      inlineData: { mimeType: 'image/jpeg', data: 'abc' },
    };
    expect(part.inlineData?.mimeType).toBe('image/jpeg');
  });

  it('3: GeminiPart can have both text and inlineData', () => {
    const part: GeminiPart = {
      text: 'desc',
      inlineData: { mimeType: 'image/png', data: 'xyz' },
    };
    expect(part.text).toBe('desc');
    expect(part.inlineData?.data).toBe('xyz');
  });

  it('4: GeminiContent has role and parts', () => {
    const content: GeminiContent = {
      role: 'user',
      parts: [{ text: 'hi' }],
    };
    expect(content.role).toBe('user');
    expect(content.parts).toHaveLength(1);
  });

  it('5: GeminiRequest has contents array', () => {
    const req: GeminiRequest = {
      contents: [{ role: 'user', parts: [] }],
    };
    expect(req.contents).toHaveLength(1);
  });

  it('6: GeminiRequest supports generationConfig', () => {
    const req: GeminiRequest = {
      contents: [],
      generationConfig: { responseModalities: ['IMAGE'] },
    };
    expect(req.generationConfig?.responseModalities).toContain('IMAGE');
  });

  it('7: GeminiResponse has candidates', () => {
    const res: GeminiResponse = {
      candidates: [{
        content: { role: 'model', parts: [] },
        finishReason: 'STOP',
      }],
      modelVersion: 'v1',
    };
    expect(res.candidates).toHaveLength(1);
  });

  it('8: GeminiResponse candidates have content', () => {
    const res: GeminiResponse = {
      candidates: [{
        content: { role: 'model', parts: [{ text: 'result' }] },
        finishReason: 'STOP',
      }],
      modelVersion: 'v1',
    };
    expect(res.candidates[0].content.parts[0].text).toBe('result');
  });

  it('9: GeminiResponse usageMetadata is optional', () => {
    const res: GeminiResponse = {
      candidates: [{
        content: { role: 'model', parts: [] },
        finishReason: 'STOP',
      }],
      modelVersion: 'v1',
    };
    expect(res.usageMetadata).toBeUndefined();
  });

  it('10: GeminiResponse usageMetadata has token counts', () => {
    const res: GeminiResponse = {
      candidates: [{
        content: { role: 'model', parts: [] },
        finishReason: 'STOP',
      }],
      modelVersion: 'v1',
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      },
    };
    expect(res.usageMetadata?.totalTokenCount).toBe(30);
  });
});
