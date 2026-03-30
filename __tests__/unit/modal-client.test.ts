import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('callModalStableHair', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.MODAL_ENDPOINT_URL = 'https://test--stable-hair.modal.run';
    process.env.MODAL_TIMEOUT_MS = '5000';
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(typeof response === 'string' ? response : JSON.stringify(response)),
    });
  }

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      customerPhoto: Buffer.from('test-image-data'),
      prompt: 'test prompt',
      baldCacheKey: 'abc123',
      model: 'stable-hair-v1',
      ...overrides,
    };
  }

  async function getClient() {
    const mod = await import('../../lib/modal-client');
    return mod.callModalStableHair;
  }

  // --- Configuration ---
  it('1: throws when MODAL_ENDPOINT_URL is not configured', async () => {
    process.env.MODAL_ENDPOINT_URL = '';
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('MODAL_ENDPOINT_URL is not configured');
  });

  it('2: throws when MODAL_ENDPOINT_URL is undefined', async () => {
    delete process.env.MODAL_ENDPOINT_URL;
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('MODAL_ENDPOINT_URL is not configured');
  });

  // --- Request format ---
  it('3: sends POST directly to endpoint URL (no /runsync suffix)', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput());
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://test--stable-hair.modal.run',
      expect.anything(),
    );
  });

  it('4: does NOT send Authorization header (Modal uses built-in auth)', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput());
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBeUndefined();
  });

  it('5: sends Content-Type application/json', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput());
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers['Content-Type']).toBe('application/json');
  });

  it('6: sends customer_photo as base64 directly (no input wrapper)', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput());
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.customer_photo).toBe(Buffer.from('test-image-data').toString('base64'));
    expect(body.input).toBeUndefined(); // No RunPod-style wrapper
  });

  it('7: sends prompt in payload', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput({ prompt: 'blonde hair' }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.prompt).toBe('blonde hair');
  });

  it('8: sends bald_cache_key in payload', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput({ baldCacheKey: 'cache-key-99' }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.bald_cache_key).toBe('cache-key-99');
  });

  it('9: sends reference_photo when provided', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput({ referencePhoto: Buffer.from('ref-photo') }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.reference_photo).toBe(Buffer.from('ref-photo').toString('base64'));
  });

  it('10: does not send reference_photo when not provided', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput());
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.reference_photo).toBeUndefined();
  });

  it('11: sends additional_images as base64 array', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput({ additionalImages: [Buffer.from('a'), Buffer.from('b')] }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.additional_images).toHaveLength(2);
  });

  it('12: does not send additional_images when not provided', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput());
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.additional_images).toBeUndefined();
  });

  it('13: does not send additional_images when empty array', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput({ additionalImages: [] }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.additional_images).toBeUndefined();
  });

  // --- Response handling ---
  it('14: throws on HTTP error response', async () => {
    mockFetch('Server Error', 500);
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('Modal error (500)');
  });

  it('15: throws when output contains error field', async () => {
    mockFetch({ error: 'Models not available' });
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('Modal job failed: Models not available');
  });

  it('16: returns imageBase64 from output', async () => {
    mockFetch({ image: 'base64-data', gpu_time_ms: 100 });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.imageBase64).toBe('base64-data');
  });

  it('17: returns latencyMs', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('18: calculates estimatedCostUsd with Modal rate ($0.000342/s)', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 1000 });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.estimatedCostUsd).toBeCloseTo(0.000342, 6);
  });

  it('19: uses latencyMs when gpu_time_ms not in output', async () => {
    mockFetch({ image: 'abc' });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('20: returns model from output', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100, model: 'stable-hair-v2' });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.model).toBe('stable-hair-v2');
  });

  it('21: uses default model when not in output', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.model).toBe('stable-hair-v1');
  });

  it('22: uses POST method', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput());
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].method).toBe('POST');
  });

  it('23: includes abort signal for timeout', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput());
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].signal).toBeDefined();
  });

  it('24: handles 502 gateway error', async () => {
    mockFetch('Bad Gateway', 502);
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('Modal error (502)');
  });

  it('25: cost calculation for 3 seconds of GPU time', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 3000 });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.estimatedCostUsd).toBeCloseTo(0.001026, 6);
  });

  it('26: handles 401 unauthorized error', async () => {
    mockFetch('Unauthorized', 401);
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('Modal error (401)');
  });

  it('27: handles 503 service unavailable', async () => {
    mockFetch('Service Unavailable', 503);
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('Modal error (503)');
  });

  it('28: cost is 0 when gpu_time_ms is 0', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 0 });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.estimatedCostUsd).toBe(0);
  });

  it('29: handles large gpu_time_ms', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 60000 });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.estimatedCostUsd).toBeCloseTo(0.02052, 4);
  });

  it('30: single additional image sends array of length 1', async () => {
    mockFetch({ image: 'abc', gpu_time_ms: 100 });
    const call = await getClient();
    await call(makeInput({ additionalImages: [Buffer.from('single')] }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.additional_images).toHaveLength(1);
  });
});
