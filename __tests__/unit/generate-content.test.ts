import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock both backend clients
vi.mock('../../lib/runpod-client', () => ({
  callRunPodStableHair: vi.fn(),
}));
vi.mock('../../lib/modal-client', () => ({
  callModalStableHair: vi.fn(),
}));

import { callRunPodStableHair } from '../../lib/runpod-client';
import { callModalStableHair } from '../../lib/modal-client';

function mockBackendResult(overrides: Record<string, unknown> = {}) {
  const result = {
    imageBase64: 'generated-image-base64',
    latencyMs: 1500,
    estimatedCostUsd: 0.0005,
    model: 'stable-hair-v1',
    ...overrides,
  };
  (callRunPodStableHair as any).mockResolvedValue(result);
  (callModalStableHair as any).mockResolvedValue(result);
  return result;
}

function makeImageBase64() {
  return Buffer.from('fake-image-pixels').toString('base64');
}

function makeRequest(parts: any[]) {
  return {
    contents: [{ role: 'user', parts }],
  };
}

describe('processGenerateContent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.BACKEND = 'runpod';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function getProcessor() {
    // Need to re-import to pick up env changes
    vi.resetModules();
    vi.doMock('../../lib/runpod-client', () => ({
      callRunPodStableHair: callRunPodStableHair,
    }));
    vi.doMock('../../lib/modal-client', () => ({
      callModalStableHair: callModalStableHair,
    }));
    const mod = await import('../../lib/generate-content');
    return mod.processGenerateContent;
  }

  // --- Input extraction ---
  it('1: throws when no images provided', async () => {
    const process = await getProcessor();
    await expect(
      process('model', makeRequest([{ text: 'hello' }])),
    ).rejects.toThrow('No image provided');
  });

  it('2: throws when contents is empty', async () => {
    const process = await getProcessor();
    await expect(
      process('model', { contents: [{ role: 'user', parts: [] }] }),
    ).rejects.toThrow('No image provided');
  });

  it('3: extracts single customer photo', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const imgB64 = makeImageBase64();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({
        customerPhoto: expect.any(Buffer),
      }),
    );
  });

  it('4: extracts customer + reference photos', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
      { inlineData: { mimeType: 'image/jpeg', data: img } },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({
        customerPhoto: expect.any(Buffer),
        referencePhoto: expect.any(Buffer),
      }),
    );
  });

  it('5: extracts additional images (3rd+ images)', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
      { inlineData: { mimeType: 'image/jpeg', data: img } },
      { inlineData: { mimeType: 'image/jpeg', data: img } },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalImages: expect.any(Array),
      }),
    );
  });

  it('6: extracts text prompt from parts', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
      { text: 'make hair blonde' },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'make hair blonde',
      }),
    );
  });

  it('7: concatenates multiple text parts', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
      { text: 'first part' },
      { text: 'second part' },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'first part\nsecond part',
      }),
    );
  });

  it('8: sets prompt to empty string when no text parts', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '',
      }),
    );
  });

  it('9: passes model name to backend', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('stable-hair-v1', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'stable-hair-v1',
      }),
    );
  });

  it('10: generates baldCacheKey from customer photo hash', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
    ]));
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.baldCacheKey).toMatch(/^[a-f0-9]{16}$/);
  });

  it('11: same image produces same baldCacheKey', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
    ]));
    const key1 = (callRunPodStableHair as any).mock.calls[0][0].baldCacheKey;
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
    ]));
    const key2 = (callRunPodStableHair as any).mock.calls[1][0].baldCacheKey;
    expect(key1).toBe(key2);
  });

  it('12: different images produce different baldCacheKey', async () => {
    mockBackendResult();
    const process = await getProcessor();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('img1').toString('base64') } },
    ]));
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('img2').toString('base64') } },
    ]));
    const key1 = (callRunPodStableHair as any).mock.calls[0][0].baldCacheKey;
    const key2 = (callRunPodStableHair as any).mock.calls[1][0].baldCacheKey;
    expect(key1).not.toBe(key2);
  });

  // --- Response format ---
  it('13: response has candidates array', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const result = await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    expect(result.candidates).toBeInstanceOf(Array);
    expect(result.candidates).toHaveLength(1);
  });

  it('14: candidate has content with role model', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const result = await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    expect(result.candidates[0].content.role).toBe('model');
  });

  it('15: candidate has finishReason STOP', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const result = await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('16: response has modelVersion', async () => {
    mockBackendResult({ model: 'my-model' });
    const process = await getProcessor();
    const result = await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    expect(result.modelVersion).toBe('my-model');
  });

  it('17: response has usageMetadata', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const result = await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    expect(result.usageMetadata).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    });
  });

  it('18: response parts contain image inlineData', async () => {
    mockBackendResult({ imageBase64: 'result-img' });
    const process = await getProcessor();
    const result = await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    const parts = result.candidates[0].content.parts;
    expect(parts[0].inlineData?.mimeType).toBe('image/jpeg');
    expect(parts[0].inlineData?.data).toBe('result-img');
  });

  it('19: response parts contain text metadata', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const result = await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    const parts = result.candidates[0].content.parts;
    expect(parts[1].text).toBeDefined();
    const meta = JSON.parse(parts[1].text!);
    expect(meta).toHaveProperty('model');
    expect(meta).toHaveProperty('latencyMs');
  });

  it('20: metadata includes estimatedCostUsd', async () => {
    mockBackendResult({ estimatedCostUsd: 0.001 });
    const process = await getProcessor();
    const result = await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    const meta = JSON.parse(result.candidates[0].content.parts[1].text!);
    expect(meta.estimatedCostUsd).toBe(0.001);
  });

  it('21: metadata includes baldCacheKey', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const result = await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    const meta = JSON.parse(result.candidates[0].content.parts[1].text!);
    expect(meta.baldCacheKey).toMatch(/^[a-f0-9]{16}$/);
  });

  // --- Multiple contents ---
  it('22: handles multiple contents with images across them', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('model', {
      contents: [
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: img } }] },
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: img } }] },
      ],
    });
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({
        referencePhoto: expect.any(Buffer),
      }),
    );
  });

  it('23: referencePhoto is undefined when only one image', async () => {
    mockBackendResult();
    const process = await getProcessor();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.referencePhoto).toBeUndefined();
  });

  it('24: additionalImages is undefined when two or fewer images', async () => {
    mockBackendResult();
    const process = await getProcessor();
    const img = makeImageBase64();
    await process('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
      { inlineData: { mimeType: 'image/jpeg', data: img } },
    ]));
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.additionalImages).toBeUndefined();
  });

  // --- Backend selection ---
  it('25: uses runpod backend by default', async () => {
    delete process.env.BACKEND;
    mockBackendResult();
    const process2 = await getProcessor();
    await process2('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalled();
    expect(callModalStableHair).not.toHaveBeenCalled();
  });

  it('26: uses modal backend when BACKEND=modal', async () => {
    process.env.BACKEND = 'modal';
    mockBackendResult();
    const process2 = await getProcessor();
    await process2('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    expect(callModalStableHair).toHaveBeenCalled();
    expect(callRunPodStableHair).not.toHaveBeenCalled();
  });

  it('27: uses runpod backend when BACKEND=runpod', async () => {
    process.env.BACKEND = 'runpod';
    mockBackendResult();
    const process2 = await getProcessor();
    await process2('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalled();
  });

  it('28: uses runpod backend for unknown BACKEND value', async () => {
    process.env.BACKEND = 'unknown';
    mockBackendResult();
    const process2 = await getProcessor();
    await process2('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: makeImageBase64() } },
    ]));
    expect(callRunPodStableHair).toHaveBeenCalled();
  });

  // --- Parts with mixed content ---
  it('29: handles interleaved text and image parts', async () => {
    mockBackendResult();
    const process2 = await getProcessor();
    const img = makeImageBase64();
    await process2('model', makeRequest([
      { text: 'before' },
      { inlineData: { mimeType: 'image/jpeg', data: img } },
      { text: 'after' },
    ]));
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toBe('before\nafter');
    expect(call.customerPhoto).toBeInstanceOf(Buffer);
  });

  it('30: handles parts with no text and no inlineData', async () => {
    mockBackendResult();
    const process2 = await getProcessor();
    const img = makeImageBase64();
    await process2('model', makeRequest([
      { inlineData: { mimeType: 'image/jpeg', data: img } },
      {},  // empty part
    ]));
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toBe('');
  });
});
