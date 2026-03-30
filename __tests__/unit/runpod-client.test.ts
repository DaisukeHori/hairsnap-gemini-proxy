import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('callRunPodStableHair', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.RUNPOD_ENDPOINT_URL = 'https://api.runpod.ai/v2/test-endpoint';
    process.env.RUNPOD_API_KEY = 'test-runpod-key';
    process.env.RUNPOD_TIMEOUT_MS = '5000';
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
      text: () => Promise.resolve(JSON.stringify(response)),
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
    const mod = await import('../../lib/runpod-client');
    return mod.callRunPodStableHair;
  }

  // --- Configuration ---
  it('1: throws when RUNPOD_ENDPOINT_URL is not configured', async () => {
    process.env.RUNPOD_ENDPOINT_URL = '';
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('RUNPOD_ENDPOINT_URL is not configured');
  });

  it('2: throws when RUNPOD_ENDPOINT_URL is undefined', async () => {
    delete process.env.RUNPOD_ENDPOINT_URL;
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('RUNPOD_ENDPOINT_URL is not configured');
  });

  // --- Request format ---
  it('3: sends POST to URL/runsync', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput());
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.runpod.ai/v2/test-endpoint/runsync',
      expect.anything(),
    );
  });

  it('4: sends Authorization Bearer header', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput());
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer test-runpod-key');
  });

  it('5: sends Content-Type application/json', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput());
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers['Content-Type']).toBe('application/json');
  });

  it('6: sends customer_photo as base64 in input wrapper', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput());
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input.customer_photo).toBe(Buffer.from('test-image-data').toString('base64'));
  });

  it('7: sends prompt in payload', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput({ prompt: 'make hair red' }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input.prompt).toBe('make hair red');
  });

  it('8: sends bald_cache_key in payload', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput({ baldCacheKey: 'key-xyz' }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input.bald_cache_key).toBe('key-xyz');
  });

  it('9: sends reference_photo when provided', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput({ referencePhoto: Buffer.from('ref-photo') }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input.reference_photo).toBe(Buffer.from('ref-photo').toString('base64'));
  });

  it('10: does not send reference_photo when not provided', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput());
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input.reference_photo).toBeUndefined();
  });

  it('11: sends additional_images as base64 array when provided', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput({ additionalImages: [Buffer.from('img1'), Buffer.from('img2')] }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input.additional_images).toHaveLength(2);
    expect(body.input.additional_images[0]).toBe(Buffer.from('img1').toString('base64'));
  });

  it('12: does not send additional_images when not provided', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput());
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input.additional_images).toBeUndefined();
  });

  it('13: does not send additional_images when empty array', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput({ additionalImages: [] }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input.additional_images).toBeUndefined();
  });

  // --- Response handling ---
  it('14: throws on HTTP error response', async () => {
    mockFetch('Server Error', 500);
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('RunPod error (500)');
  });

  it('15: throws on FAILED status', async () => {
    mockFetch({ status: 'FAILED', error: 'GPU OOM' });
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('RunPod job failed: GPU OOM');
  });

  it('16: throws on FAILED with no error message', async () => {
    mockFetch({ status: 'FAILED' });
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('RunPod job failed: Unknown reason');
  });

  it('17: throws on unexpected status', async () => {
    mockFetch({ status: 'IN_QUEUE' });
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('RunPod unexpected status: IN_QUEUE');
  });

  it('18: throws on IN_PROGRESS status', async () => {
    mockFetch({ status: 'IN_PROGRESS' });
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('RunPod unexpected status: IN_PROGRESS');
  });

  it('19: returns imageBase64 from output', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'base64-image-data', gpu_time_ms: 100 } });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.imageBase64).toBe('base64-image-data');
  });

  it('20: returns latencyMs', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('21: calculates estimatedCostUsd from gpu_time_ms', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 1000 } });
    const call = await getClient();
    const result = await call(makeInput());
    // 1000ms = 1s, $0.00035/s
    expect(result.estimatedCostUsd).toBeCloseTo(0.00035, 5);
  });

  it('22: uses latencyMs when gpu_time_ms not in output', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc' } });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('23: returns model from output', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100, model: 'custom-model' } });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.model).toBe('custom-model');
  });

  it('24: uses default model when not in output', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.model).toBe('stable-hair-v1');
  });

  it('25: uses POST method', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput());
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].method).toBe('POST');
  });

  it('26: wraps payload in input object', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput());
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body).toHaveProperty('input');
    expect(body.input).toHaveProperty('customer_photo');
  });

  it('27: includes abort signal for timeout', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 100 } });
    const call = await getClient();
    await call(makeInput());
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].signal).toBeDefined();
  });

  it('28: handles 404 error', async () => {
    mockFetch('Not Found', 404);
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('RunPod error (404)');
  });

  it('29: handles 429 rate limit error', async () => {
    mockFetch('Rate Limited', 429);
    const call = await getClient();
    await expect(call(makeInput())).rejects.toThrow('RunPod error (429)');
  });

  it('30: cost calculation for 5 seconds of GPU time', async () => {
    mockFetch({ status: 'COMPLETED', output: { image: 'abc', gpu_time_ms: 5000 } });
    const call = await getClient();
    const result = await call(makeInput());
    expect(result.estimatedCostUsd).toBeCloseTo(0.00175, 5);
  });
});
