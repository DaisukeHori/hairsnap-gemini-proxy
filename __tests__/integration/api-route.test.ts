/**
 * Integration tests: full API route handler flow
 * Tests auth → routing → content processing → response format
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock next/server
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
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new MockHeaders(init?.headers);
    }
    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(data, init);
    }
    async json() { return this.body; }
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

// Mock backend clients
vi.mock('../../lib/runpod-client', () => ({
  callRunPodStableHair: vi.fn(),
}));
vi.mock('../../lib/modal-client', () => ({
  callModalStableHair: vi.fn(),
}));

import { callRunPodStableHair } from '../../lib/runpod-client';
import { callModalStableHair } from '../../lib/modal-client';

const originalEnv = process.env;
const imgB64 = Buffer.from('fake-image-data').toString('base64');

function mockBackend(overrides: Record<string, unknown> = {}) {
  const result = {
    imageBase64: 'output-image',
    latencyMs: 1000,
    estimatedCostUsd: 0.0005,
    model: 'stable-hair-v1',
    ...overrides,
  };
  (callRunPodStableHair as any).mockResolvedValue(result);
  (callModalStableHair as any).mockResolvedValue(result);
  return result;
}

function makeGeminiBody(parts: any[] = []) {
  return {
    contents: [{ role: 'user', parts }],
  };
}

async function callRoute(path: string[], opts: {
  headers?: Record<string, string>;
  body?: unknown;
  queryKey?: string;
} = {}) {
  const { NextRequest } = await import('next/server');
  const url = `http://localhost/api/v1beta/models/${path.join('/')}${opts.queryKey ? `?key=${opts.queryKey}` : ''}`;
  const request = new (NextRequest as any)(url, {
    method: 'POST',
    headers: opts.headers ?? {},
    body: opts.body ? JSON.stringify(opts.body) : '{}',
  });
  const { POST } = await import('../../app/api/v1beta/models/[...path]/route');
  return POST(request, { params: Promise.resolve({ path }) });
}

describe('API Route Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.PROXY_API_KEY = 'test-api-key';
    process.env.BACKEND = 'runpod';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // === AUTH + ROUTING (1-25) ===

  it('1: returns 401 when no API key provided', async () => {
    const res = await callRoute(['stable-hair-v1:generateContent']);
    expect((res as any).status).toBe(401);
  });

  it('2: returns 401 with wrong API key in header', async () => {
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'wrong-key' },
    });
    expect((res as any).status).toBe(401);
  });

  it('3: returns 401 with wrong API key in query', async () => {
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      queryKey: 'wrong-key',
    });
    expect((res as any).status).toBe(401);
  });

  it('4: accepts valid API key in header', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).status).toBe(200);
  });

  it('5: accepts valid API key in query param', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      queryKey: 'test-api-key',
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).status).toBe(200);
  });

  it('6: allows all requests when PROXY_API_KEY not set', async () => {
    delete process.env.PROXY_API_KEY;
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).status).toBe(200);
  });

  it('7: returns 400 for unsupported method', async () => {
    const res = await callRoute(['stable-hair-v1:streamGenerateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
    });
    expect((res as any).status).toBe(400);
  });

  it('8: error body for unsupported method has INVALID_ARGUMENT', async () => {
    const res = await callRoute(['stable-hair-v1:streamGenerateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
    });
    const body = (res as any).body;
    expect(body.error.status).toBe('INVALID_ARGUMENT');
  });

  it('9: error message includes the path', async () => {
    const res = await callRoute(['stable-hair-v1:streamGenerateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
    });
    const body = (res as any).body;
    expect(body.error.message).toContain('stable-hair-v1:streamGenerateContent');
  });

  it('10: returns 400 for completely wrong path', async () => {
    const res = await callRoute(['nonexistent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
    });
    expect((res as any).status).toBe(400);
  });

  it('11: extracts model name from path correctly', async () => {
    mockBackend();
    const res = await callRoute(['my-custom-model:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'my-custom-model' }),
    );
  });

  it('12: handles nested model path', async () => {
    mockBackend();
    const res = await callRoute(['some', 'nested', 'model:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'some/nested/model' }),
    );
  });

  // === CONTENT PROCESSING (13-50) ===

  it('13: processes single customer photo', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).status).toBe(200);
    expect(callRunPodStableHair).toHaveBeenCalled();
  });

  it('14: processes customer + reference photos', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({
        customerPhoto: expect.any(Buffer),
        referencePhoto: expect.any(Buffer),
      }),
    );
  });

  it('15: processes 3 images (customer + ref + additional)', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.additionalImages).toHaveLength(1);
  });

  it('16: processes text + image parts together', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { text: 'make hair red' },
      ]),
    });
    expect(callRunPodStableHair).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'make hair red' }),
    );
  });

  it('17: returns 500 when no images provided', async () => {
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([{ text: 'no image here' }]),
    });
    expect((res as any).status).toBe(500);
  });

  it('18: error message mentions image required', async () => {
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([{ text: 'no image' }]),
    });
    const body = (res as any).body;
    expect(body.error.message).toContain('image');
  });

  it('19: returns 500 when backend throws', async () => {
    (callRunPodStableHair as any).mockRejectedValue(new Error('Backend down'));
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).status).toBe(500);
  });

  it('20: error from backend is propagated in message', async () => {
    (callRunPodStableHair as any).mockRejectedValue(new Error('GPU OOM'));
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const body = (res as any).body;
    expect(body.error.message).toBe('GPU OOM');
  });

  it('21: error has INTERNAL status', async () => {
    (callRunPodStableHair as any).mockRejectedValue(new Error('fail'));
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const body = (res as any).body;
    expect(body.error.status).toBe('INTERNAL');
  });

  it('22: returns 400 for invalid JSON body', async () => {
    const { NextRequest } = await import('next/server');
    const request = new (NextRequest as any)('http://localhost/api/v1beta/models/m:generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: '{}',
    });
    // Override json() to throw
    request.json = () => Promise.reject(new SyntaxError('invalid json'));
    const { POST } = await import('../../app/api/v1beta/models/[...path]/route');
    const res = await POST(request, { params: Promise.resolve({ path: ['m:generateContent'] }) });
    expect((res as any).status).toBe(400);
  });

  it('23: invalid JSON error has proper message', async () => {
    const { NextRequest } = await import('next/server');
    const request = new (NextRequest as any)('http://localhost/api/v1beta/models/m:generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: '{}',
    });
    request.json = () => Promise.reject(new SyntaxError('invalid'));
    const { POST } = await import('../../app/api/v1beta/models/[...path]/route');
    const res = await POST(request, { params: Promise.resolve({ path: ['m:generateContent'] }) });
    expect((res as any).body.error.message).toBe('Invalid JSON body');
  });

  // === RESPONSE FORMAT (24-50) ===

  it('24: success response has candidates array', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const body = (res as any).body;
    expect(body.candidates).toBeInstanceOf(Array);
  });

  it('25: success response has exactly 1 candidate', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).body.candidates).toHaveLength(1);
  });

  it('26: candidate content role is model', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).body.candidates[0].content.role).toBe('model');
  });

  it('27: candidate has STOP finishReason', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).body.candidates[0].finishReason).toBe('STOP');
  });

  it('28: response has 2 parts (image + metadata)', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).body.candidates[0].content.parts).toHaveLength(2);
  });

  it('29: first part is image inlineData', async () => {
    mockBackend({ imageBase64: 'result-b64' });
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const part0 = (res as any).body.candidates[0].content.parts[0];
    expect(part0.inlineData.mimeType).toBe('image/jpeg');
    expect(part0.inlineData.data).toBe('result-b64');
  });

  it('30: second part is text metadata JSON', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const part1 = (res as any).body.candidates[0].content.parts[1];
    expect(part1.text).toBeDefined();
    const meta = JSON.parse(part1.text);
    expect(meta).toHaveProperty('model');
  });

  it('31: metadata includes latencyMs', async () => {
    mockBackend({ latencyMs: 2500 });
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const meta = JSON.parse((res as any).body.candidates[0].content.parts[1].text);
    expect(meta.latencyMs).toBe(2500);
  });

  it('32: metadata includes estimatedCostUsd', async () => {
    mockBackend({ estimatedCostUsd: 0.002 });
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const meta = JSON.parse((res as any).body.candidates[0].content.parts[1].text);
    expect(meta.estimatedCostUsd).toBe(0.002);
  });

  it('33: metadata includes baldCacheKey', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const meta = JSON.parse((res as any).body.candidates[0].content.parts[1].text);
    expect(meta.baldCacheKey).toMatch(/^[a-f0-9]{16}$/);
  });

  it('34: response has modelVersion', async () => {
    mockBackend({ model: 'stable-hair-v1' });
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).body.modelVersion).toBe('stable-hair-v1');
  });

  it('35: response has usageMetadata with zero counts', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const usage = (res as any).body.usageMetadata;
    expect(usage.promptTokenCount).toBe(0);
    expect(usage.candidatesTokenCount).toBe(0);
    expect(usage.totalTokenCount).toBe(0);
  });

  // === BACKEND ROUTING (36-45) ===

  it('36: uses RunPod when BACKEND=runpod', async () => {
    process.env.BACKEND = 'runpod';
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect(callRunPodStableHair).toHaveBeenCalled();
    expect(callModalStableHair).not.toHaveBeenCalled();
  });

  it('37: calls backend when BACKEND=runpod (default)', async () => {
    // Backend switching is tested in unit tests; here we verify the default path works
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    expect((res as any).status).toBe(200);
    expect(callRunPodStableHair).toHaveBeenCalled();
  });

  it('38: backend returns result that flows through to response', async () => {
    mockBackend({ imageBase64: 'specific-output', model: 'test-model-v2' });
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const body = (res as any).body;
    expect(body.candidates[0].content.parts[0].inlineData.data).toBe('specific-output');
    expect(body.modelVersion).toBe('test-model-v2');
  });

  it('39: passes correct customerPhoto buffer to backend', async () => {
    mockBackend();
    const specificImg = Buffer.from('specific-photo').toString('base64');
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: specificImg } },
      ]),
    });
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.customerPhoto).toEqual(Buffer.from(specificImg, 'base64'));
  });

  it('40: passes correct prompt to backend', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { text: 'platinum blonde bob' },
      ]),
    });
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toBe('platinum blonde bob');
  });

  it('41: generates consistent baldCacheKey for same image', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const key1 = (callRunPodStableHair as any).mock.calls[0][0].baldCacheKey;
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const key2 = (callRunPodStableHair as any).mock.calls[1][0].baldCacheKey;
    expect(key1).toBe(key2);
  });

  it('42: generates different baldCacheKey for different images', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('img-a').toString('base64') } },
      ]),
    });
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('img-b').toString('base64') } },
      ]),
    });
    const k1 = (callRunPodStableHair as any).mock.calls[0][0].baldCacheKey;
    const k2 = (callRunPodStableHair as any).mock.calls[1][0].baldCacheKey;
    expect(k1).not.toBe(k2);
  });

  // === EDGE CASES (43-50) ===

  it('43: handles empty text prompt', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { text: '' },
      ]),
    });
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toBe('');
  });

  it('44: handles very long prompt', async () => {
    mockBackend();
    const longPrompt = 'a'.repeat(10000);
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { text: longPrompt },
      ]),
    });
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toBe(longPrompt);
  });

  it('45: handles multiple contents in request', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: {
        contents: [
          { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: imgB64 } }] },
          { role: 'user', parts: [{ text: 'style it' }] },
        ],
      },
    });
    expect((res as any).status).toBe(200);
  });

  it('46: handles 4 images (customer + ref + 2 additional)', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.additionalImages).toHaveLength(2);
  });

  it('47: handles PNG mime type', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/png', data: imgB64 } },
      ]),
    });
    expect(callRunPodStableHair).toHaveBeenCalled();
  });

  it('48: response image is always jpeg', async () => {
    mockBackend();
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/png', data: imgB64 } },
      ]),
    });
    const part0 = (res as any).body.candidates[0].content.parts[0];
    expect(part0.inlineData.mimeType).toBe('image/jpeg');
  });

  it('49: handles Japanese text in prompt', async () => {
    mockBackend();
    await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
        { text: '金髪のボブカット' },
      ]),
    });
    const call = (callRunPodStableHair as any).mock.calls[0][0];
    expect(call.prompt).toBe('金髪のボブカット');
  });

  it('50: non-Error thrown by backend uses Internal error message', async () => {
    (callRunPodStableHair as any).mockRejectedValue('string error');
    const res = await callRoute(['stable-hair-v1:generateContent'], {
      headers: { 'x-goog-api-key': 'test-api-key' },
      body: makeGeminiBody([
        { inlineData: { mimeType: 'image/jpeg', data: imgB64 } },
      ]),
    });
    const body = (res as any).body;
    expect(body.error.message).toBe('Internal error');
  });
});
