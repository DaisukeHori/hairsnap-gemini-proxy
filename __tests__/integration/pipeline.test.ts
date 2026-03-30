/**
 * Integration tests: end-to-end pipeline scenarios
 * Simulates real-world request patterns from gpu-mirror → proxy → backend
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/server', () => {
  class MockHeaders {
    private map: Record<string, string>;
    constructor(init?: Record<string, string>) { this.map = { ...init }; }
    get(name: string) { return this.map[name.toLowerCase()] ?? null; }
    set(name: string, val: string) { this.map[name.toLowerCase()] = val; }
    has(name: string) { return name.toLowerCase() in this.map; }
  }
  class MockNextResponse {
    body: unknown;
    status: number;
    headers: MockHeaders;
    constructor(body: unknown, init?: { status?: number }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new MockHeaders();
    }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init);
    }
  }
  class MockNextRequest {
    headers: MockHeaders;
    nextUrl: { searchParams: URLSearchParams };
    private _body: unknown;
    method: string;
    constructor(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) {
      this.method = opts?.method ?? 'GET';
      this.headers = new MockHeaders(opts?.headers);
      this.nextUrl = { searchParams: new URL(url, 'http://localhost').searchParams };
      this._body = opts?.body ? JSON.parse(opts.body) : null;
    }
    async json() { return this._body; }
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

vi.mock('../../lib/runpod-client', () => ({
  callRunPodStableHair: vi.fn(),
}));
vi.mock('../../lib/modal-client', () => ({
  callModalStableHair: vi.fn(),
}));

import { callRunPodStableHair } from '../../lib/runpod-client';
import { callModalStableHair } from '../../lib/modal-client';

const originalEnv = process.env;

function mockBackend(overrides: Record<string, unknown> = {}) {
  const result = {
    imageBase64: 'generated-image',
    latencyMs: 1500,
    estimatedCostUsd: 0.0005,
    model: 'stable-hair-v1',
    ...overrides,
  };
  (callRunPodStableHair as any).mockResolvedValue(result);
  (callModalStableHair as any).mockResolvedValue(result);
  return result;
}

// Simulate a realistic Gemini SDK request
function makeRealisticRequest(opts: {
  customerPhotoSize?: number;
  referencePhotoSize?: number;
  prompt?: string;
  model?: string;
} = {}) {
  const parts: any[] = [];
  // Customer photo
  const customerData = Buffer.alloc(opts.customerPhotoSize ?? 1024).fill(65);
  parts.push({ inlineData: { mimeType: 'image/jpeg', data: customerData.toString('base64') } });
  // Reference photo
  if (opts.referencePhotoSize !== undefined) {
    const refData = Buffer.alloc(opts.referencePhotoSize).fill(66);
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: refData.toString('base64') } });
  }
  // Prompt
  if (opts.prompt) {
    parts.push({ text: opts.prompt });
  }
  return {
    model: opts.model ?? 'stable-hair-v1',
    body: { contents: [{ role: 'user', parts }] },
  };
}

async function callEndpoint(model: string, body: unknown, apiKey = 'test-key') {
  const { NextRequest } = await import('next/server');
  const url = `http://localhost/api/v1beta/models/${model}:generateContent`;
  const request = new (NextRequest as any)(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const { POST } = await import('../../app/api/v1beta/models/[...path]/route');
  return POST(request, { params: Promise.resolve({ path: [`${model}:generateContent`] }) });
}

describe('Pipeline Integration - Real-world scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.PROXY_API_KEY = 'test-key';
    process.env.BACKEND = 'runpod';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // === Bald-only flow (customer photo only) ===
  it('1: bald-only request succeeds', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    expect((res as any).status).toBe(200);
  });

  it('2: bald-only sends no referencePhoto', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest();
    await callEndpoint(model, body);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.referencePhoto).toBeUndefined();
  });

  it('3: bald-only response has generated image', async () => {
    mockBackend({ imageBase64: 'bald-result' });
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    expect((res as any).body.candidates[0].content.parts[0].inlineData.data).toBe('bald-result');
  });

  // === Hair transfer flow (customer + reference) ===
  it('4: hair transfer request succeeds', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({ referencePhotoSize: 1024 });
    const res = await callEndpoint(model, body);
    expect((res as any).status).toBe(200);
  });

  it('5: hair transfer sends referencePhoto', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({ referencePhotoSize: 1024 });
    await callEndpoint(model, body);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.referencePhoto).toBeInstanceOf(Buffer);
  });

  it('6: hair transfer with prompt', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({
      referencePhotoSize: 512,
      prompt: 'blonde highlights',
    });
    await callEndpoint(model, body);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toBe('blonde highlights');
    expect(call.referencePhoto).toBeInstanceOf(Buffer);
  });

  // === Error scenarios ===
  it('7: backend timeout returns 500', async () => {
    (callRunPodStableHair as any).mockRejectedValue(new Error('Request timed out'));
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    expect((res as any).status).toBe(500);
    expect((res as any).body.error.message).toContain('timed out');
  });

  it('8: backend GPU OOM returns 500', async () => {
    (callRunPodStableHair as any).mockRejectedValue(new Error('CUDA out of memory'));
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    expect((res as any).status).toBe(500);
    expect((res as any).body.error.message).toContain('CUDA');
  });

  it('9: backend connection refused returns 500', async () => {
    (callRunPodStableHair as any).mockRejectedValue(new Error('ECONNREFUSED'));
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    expect((res as any).status).toBe(500);
  });

  it('10: invalid auth returns 401 before hitting backend', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body, 'wrong-key');
    expect((res as any).status).toBe(401);
    expect(callRunPodStableHair).not.toHaveBeenCalled();
  });

  // === Multiple sequential requests ===
  it('11: consecutive requests each get unique processing', async () => {
    let callCount = 0;
    (callRunPodStableHair as any).mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        imageBase64: `image-${callCount}`,
        latencyMs: 100,
        estimatedCostUsd: 0.001,
        model: 'stable-hair-v1',
      });
    });
    const { model, body } = makeRealisticRequest();
    const res1 = await callEndpoint(model, body);
    const res2 = await callEndpoint(model, body);
    expect((res1 as any).body.candidates[0].content.parts[0].inlineData.data).toBe('image-1');
    expect((res2 as any).body.candidates[0].content.parts[0].inlineData.data).toBe('image-2');
  });

  // === Model name variations ===
  it('12: works with stable-hair-v1 model', async () => {
    mockBackend();
    const res = await callEndpoint('stable-hair-v1', makeRealisticRequest().body);
    expect((res as any).status).toBe(200);
  });

  it('13: works with custom model name', async () => {
    mockBackend();
    const res = await callEndpoint('custom-model-v2', makeRealisticRequest().body);
    expect((res as any).status).toBe(200);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.model).toBe('custom-model-v2');
  });

  it('14: works with gemini-style model name', async () => {
    mockBackend();
    const res = await callEndpoint('gemini-2.0-flash', makeRealisticRequest().body);
    expect((res as any).status).toBe(200);
  });

  // === Response structure validation ===
  it('15: response is Gemini API compatible', async () => {
    mockBackend({ imageBase64: 'img', model: 'stable-hair-v1', latencyMs: 500, estimatedCostUsd: 0.001 });
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    const r = (res as any).body;
    // Validate Gemini response structure
    expect(r).toHaveProperty('candidates');
    expect(r).toHaveProperty('modelVersion');
    expect(r.candidates[0]).toHaveProperty('content');
    expect(r.candidates[0]).toHaveProperty('finishReason');
    expect(r.candidates[0].content).toHaveProperty('role');
    expect(r.candidates[0].content).toHaveProperty('parts');
  });

  it('16: response metadata is valid JSON', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    const metaText = (res as any).body.candidates[0].content.parts[1].text;
    expect(() => JSON.parse(metaText)).not.toThrow();
  });

  it('17: response metadata has all required fields', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    const meta = JSON.parse((res as any).body.candidates[0].content.parts[1].text);
    expect(meta).toHaveProperty('model');
    expect(meta).toHaveProperty('latencyMs');
    expect(meta).toHaveProperty('estimatedCostUsd');
    expect(meta).toHaveProperty('baldCacheKey');
  });

  // === Photo size variations ===
  it('18: handles small photo (100 bytes)', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({ customerPhotoSize: 100 });
    const res = await callEndpoint(model, body);
    expect((res as any).status).toBe(200);
  });

  it('19: handles medium photo (100KB)', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({ customerPhotoSize: 100 * 1024 });
    const res = await callEndpoint(model, body);
    expect((res as any).status).toBe(200);
  });

  it('20: handles large photo (1MB)', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({ customerPhotoSize: 1024 * 1024 });
    const res = await callEndpoint(model, body);
    expect((res as any).status).toBe(200);
  });

  // === Prompt variations ===
  it('21: handles empty prompt (no text part)', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    expect((res as any).status).toBe(200);
  });

  it('22: handles Japanese prompt', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({ prompt: '金髪ボブカットにしてください' });
    await callEndpoint(model, body);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toBe('金髪ボブカットにしてください');
  });

  it('23: handles emoji in prompt', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({ prompt: '💇‍♀️ new hairstyle' });
    await callEndpoint(model, body);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toContain('💇‍♀️');
  });

  it('24: handles multiline prompt', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({ prompt: 'line1\nline2\nline3' });
    await callEndpoint(model, body);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toBe('line1\nline2\nline3');
  });

  // === Auth edge cases in pipeline ===
  it('25: auth check happens before JSON parsing', async () => {
    const { NextRequest } = await import('next/server');
    const request = new (NextRequest as any)('http://localhost/api/v1beta/models/m:generateContent', {
      method: 'POST',
      headers: {},
      body: '{}',
    });
    request.json = () => Promise.reject(new Error('bad json'));
    const { POST } = await import('../../app/api/v1beta/models/[...path]/route');
    const res = await POST(request, { params: Promise.resolve({ path: ['m:generateContent'] }) });
    // Should get auth error (401) not JSON error (400)
    expect((res as any).status).toBe(401);
  });

  it('26: auth check happens before path validation', async () => {
    const res = await callEndpoint('invalid', { contents: [] }, 'wrong-key');
    expect((res as any).status).toBe(401);
  });

  // === Backend input format ===
  it('27: backend receives all required fields', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest({ prompt: 'test', referencePhotoSize: 512 });
    await callEndpoint(model, body);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call).toHaveProperty('customerPhoto');
    expect(call).toHaveProperty('referencePhoto');
    expect(call).toHaveProperty('baldCacheKey');
    expect(call).toHaveProperty('model');
    expect(call).toHaveProperty('prompt', 'test');
  });

  // === Cost tracking ===
  it('28: cost is included in response metadata', async () => {
    mockBackend({ estimatedCostUsd: 0.0042 });
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    const meta = JSON.parse((res as any).body.candidates[0].content.parts[1].text);
    expect(meta.estimatedCostUsd).toBe(0.0042);
  });

  it('29: latency is included in response metadata', async () => {
    mockBackend({ latencyMs: 3500 });
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    const meta = JSON.parse((res as any).body.candidates[0].content.parts[1].text);
    expect(meta.latencyMs).toBe(3500);
  });

  // === Cache key consistency ===
  it('30: same customer photo always produces same cache key', async () => {
    mockBackend();
    const fixedPhoto = Buffer.alloc(512).fill(99);
    const parts = [{ inlineData: { mimeType: 'image/jpeg', data: fixedPhoto.toString('base64') } }];
    const body = { contents: [{ role: 'user', parts }] };
    await callEndpoint('m', body);
    await callEndpoint('m', body);
    const k1 = (callRunPodStableHair as any).mock.calls[0][0].baldCacheKey;
    const k2 = (callRunPodStableHair as any).mock.calls[1][0].baldCacheKey;
    expect(k1).toBe(k2);
  });

  it('31: different customer photos produce different cache keys', async () => {
    mockBackend();
    const photo1 = Buffer.alloc(512).fill(1);
    const photo2 = Buffer.alloc(512).fill(2);
    await callEndpoint('m', { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: photo1.toString('base64') } }] }] });
    await callEndpoint('m', { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: photo2.toString('base64') } }] }] });
    const k1 = (callRunPodStableHair as any).mock.calls[0][0].baldCacheKey;
    const k2 = (callRunPodStableHair as any).mock.calls[1][0].baldCacheKey;
    expect(k1).not.toBe(k2);
  });

  it('32: cache key is 16 hex characters', async () => {
    mockBackend();
    const { model, body } = makeRealisticRequest();
    await callEndpoint(model, body);
    const meta = JSON.parse(
      await callEndpoint(model, body).then(r => {
        mockBackend();
        return (r as any).body.candidates[0].content.parts[1].text;
      }),
    );
    expect(meta.baldCacheKey).toMatch(/^[a-f0-9]{16}$/);
  });

  // === Concurrent request simulation ===
  it('33: handles concurrent requests independently', async () => {
    let count = 0;
    (callRunPodStableHair as any).mockImplementation(() => {
      count++;
      return Promise.resolve({
        imageBase64: `result-${count}`,
        latencyMs: 100,
        estimatedCostUsd: 0.001,
        model: 'stable-hair-v1',
      });
    });
    const req = makeRealisticRequest();
    const [r1, r2, r3] = await Promise.all([
      callEndpoint(req.model, req.body),
      callEndpoint(req.model, req.body),
      callEndpoint(req.model, req.body),
    ]);
    expect((r1 as any).status).toBe(200);
    expect((r2 as any).status).toBe(200);
    expect((r3 as any).status).toBe(200);
  });

  // === Error response format ===
  it('34: 401 error has Gemini-compatible format', async () => {
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body, 'bad');
    const r = (res as any).body;
    expect(r.error).toHaveProperty('code');
    expect(r.error).toHaveProperty('message');
    expect(r.error).toHaveProperty('status');
  });

  it('35: 400 error has Gemini-compatible format', async () => {
    const { NextRequest } = await import('next/server');
    const request = new (NextRequest as any)('http://localhost/api/v1beta/models/m:badMethod', {
      method: 'POST',
      headers: { 'x-goog-api-key': 'test-key' },
      body: '{}',
    });
    const { POST } = await import('../../app/api/v1beta/models/[...path]/route');
    const res = await POST(request, { params: Promise.resolve({ path: ['m:badMethod'] }) });
    const r = (res as any).body;
    expect(r.error.code).toBe(400);
    expect(r.error.status).toBe('INVALID_ARGUMENT');
  });

  it('36: 500 error has Gemini-compatible format', async () => {
    (callRunPodStableHair as any).mockRejectedValue(new Error('boom'));
    const { model, body } = makeRealisticRequest();
    const res = await callEndpoint(model, body);
    const r = (res as any).body;
    expect(r.error.code).toBe(500);
    expect(r.error.status).toBe('INTERNAL');
  });

  // === Complex multi-part requests ===
  it('37: handles interleaved image-text-image pattern', async () => {
    mockBackend();
    const img = Buffer.from('photo').toString('base64');
    const body = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: img } },
          { text: 'middle text' },
          { inlineData: { mimeType: 'image/jpeg', data: img } },
        ],
      }],
    };
    const res = await callEndpoint('m', body);
    expect((res as any).status).toBe(200);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.customerPhoto).toBeInstanceOf(Buffer);
    expect(call.referencePhoto).toBeInstanceOf(Buffer);
    expect(call.prompt).toBe('middle text');
  });

  it('38: handles text-only content (should fail)', async () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'no images' }] }] };
    const res = await callEndpoint('m', body);
    expect((res as any).status).toBe(500);
  });

  it('39: handles multi-turn conversation format', async () => {
    mockBackend();
    const img = Buffer.from('p').toString('base64');
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'first turn' }] },
        { role: 'model', parts: [{ text: 'response' }] },
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: img } }, { text: 'second turn' }] },
      ],
    };
    const res = await callEndpoint('m', body);
    expect((res as any).status).toBe(200);
  });

  it('40: correctly gathers parts from all contents', async () => {
    mockBackend();
    const img = Buffer.from('photo').toString('base64');
    const body = {
      contents: [
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: img } }] },
        { role: 'user', parts: [{ text: 'prompt from second content' }] },
      ],
    };
    await callEndpoint('m', body);
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toContain('prompt from second content');
  });
});
