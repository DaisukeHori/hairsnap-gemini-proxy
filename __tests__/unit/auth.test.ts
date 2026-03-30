import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock next/server before importing auth
vi.mock('next/server', () => {
  class MockNextResponse {
    body: unknown;
    status: number;
    constructor(body: unknown, init?: { status?: number }) {
      this.body = body;
      this.status = init?.status ?? 200;
    }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init);
    }
  }
  return { NextRequest: vi.fn(), NextResponse: MockNextResponse };
});

function makeRequest(opts: {
  headerKey?: string | null;
  queryKey?: string | null;
}): any {
  return {
    headers: {
      get: (name: string) => {
        if (name === 'x-goog-api-key') return opts.headerKey ?? null;
        return null;
      },
    },
    nextUrl: {
      searchParams: {
        get: (name: string) => {
          if (name === 'key') return opts.queryKey ?? null;
          return null;
        },
      },
    },
  };
}

describe('validateApiKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function getValidator() {
    const mod = await import('../../lib/auth');
    return mod.validateApiKey;
  }

  // --- PROXY_API_KEY not set ---
  it('1: returns null when PROXY_API_KEY is not set', async () => {
    delete process.env.PROXY_API_KEY;
    const validate = await getValidator();
    const req = makeRequest({});
    expect(validate(req)).toBeNull();
  });

  it('2: returns null when PROXY_API_KEY is empty string', async () => {
    process.env.PROXY_API_KEY = '';
    const validate = await getValidator();
    expect(validate(makeRequest({}))).toBeNull();
  });

  it('3: logs warning when PROXY_API_KEY not set', async () => {
    delete process.env.PROXY_API_KEY;
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validate = await getValidator();
    validate(makeRequest({}));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('PROXY_API_KEY'));
    spy.mockRestore();
  });

  // --- Valid key in header ---
  it('4: returns null when valid key in x-goog-api-key header', async () => {
    process.env.PROXY_API_KEY = 'test-key-123';
    const validate = await getValidator();
    expect(validate(makeRequest({ headerKey: 'test-key-123' }))).toBeNull();
  });

  it('5: returns null when valid key in query param', async () => {
    process.env.PROXY_API_KEY = 'test-key-123';
    const validate = await getValidator();
    expect(validate(makeRequest({ queryKey: 'test-key-123' }))).toBeNull();
  });

  it('6: returns null when both header and query have valid key', async () => {
    process.env.PROXY_API_KEY = 'test-key-123';
    const validate = await getValidator();
    expect(validate(makeRequest({ headerKey: 'test-key-123', queryKey: 'test-key-123' }))).toBeNull();
  });

  // --- Invalid keys ---
  it('7: returns 401 when no key provided', async () => {
    process.env.PROXY_API_KEY = 'test-key-123';
    const validate = await getValidator();
    const result = validate(makeRequest({}));
    expect(result).not.toBeNull();
    expect((result as any).status).toBe(401);
  });

  it('8: returns 401 when wrong key in header', async () => {
    process.env.PROXY_API_KEY = 'test-key-123';
    const validate = await getValidator();
    const result = validate(makeRequest({ headerKey: 'wrong-key' }));
    expect(result).not.toBeNull();
    expect((result as any).status).toBe(401);
  });

  it('9: returns 401 when wrong key in query', async () => {
    process.env.PROXY_API_KEY = 'test-key-123';
    const validate = await getValidator();
    const result = validate(makeRequest({ queryKey: 'wrong-key' }));
    expect(result).not.toBeNull();
    expect((result as any).status).toBe(401);
  });

  it('10: error body contains code 401', async () => {
    process.env.PROXY_API_KEY = 'test-key-123';
    const validate = await getValidator();
    const result = validate(makeRequest({}));
    expect((result as any).body.error.code).toBe(401);
  });

  it('11: error body contains UNAUTHENTICATED status', async () => {
    process.env.PROXY_API_KEY = 'test-key-123';
    const validate = await getValidator();
    const result = validate(makeRequest({}));
    expect((result as any).body.error.status).toBe('UNAUTHENTICATED');
  });

  it('12: error body contains proper message', async () => {
    process.env.PROXY_API_KEY = 'test-key-123';
    const validate = await getValidator();
    const result = validate(makeRequest({}));
    expect((result as any).body.error.message).toContain('API key not valid');
  });

  it('13: header key takes precedence over query key via ?? operator', async () => {
    process.env.PROXY_API_KEY = 'correct';
    const validate = await getValidator();
    // header is correct, query is wrong — should pass
    expect(validate(makeRequest({ headerKey: 'correct', queryKey: 'wrong' }))).toBeNull();
  });

  it('14: falls back to query when header is null', async () => {
    process.env.PROXY_API_KEY = 'correct';
    const validate = await getValidator();
    expect(validate(makeRequest({ queryKey: 'correct' }))).toBeNull();
  });

  it('15: returns 401 when header is wrong and query is correct (header takes precedence)', async () => {
    process.env.PROXY_API_KEY = 'correct';
    const validate = await getValidator();
    const result = validate(makeRequest({ headerKey: 'wrong', queryKey: 'correct' }));
    expect(result).not.toBeNull();
    expect((result as any).status).toBe(401);
  });

  it('16: key comparison is case-sensitive', async () => {
    process.env.PROXY_API_KEY = 'TestKey';
    const validate = await getValidator();
    const result = validate(makeRequest({ headerKey: 'testkey' }));
    expect(result).not.toBeNull();
  });

  it('17: handles key with special characters', async () => {
    process.env.PROXY_API_KEY = 'key-with-$pecial!chars@2026';
    const validate = await getValidator();
    expect(validate(makeRequest({ headerKey: 'key-with-$pecial!chars@2026' }))).toBeNull();
  });

  it('18: handles key with unicode characters', async () => {
    process.env.PROXY_API_KEY = 'キー🔑';
    const validate = await getValidator();
    expect(validate(makeRequest({ headerKey: 'キー🔑' }))).toBeNull();
  });

  it('19: rejects empty string key when PROXY_API_KEY is set', async () => {
    process.env.PROXY_API_KEY = 'valid-key';
    const validate = await getValidator();
    // Empty string header will make headerKey ?? queryKey fall through
    // but provided = '' which !== 'valid-key'
    const result = validate(makeRequest({ headerKey: '' }));
    // '' is falsy but not null/undefined, so ?? won't fall through
    expect(result).not.toBeNull();
  });

  it('20: handles very long key', async () => {
    const longKey = 'a'.repeat(10000);
    process.env.PROXY_API_KEY = longKey;
    const validate = await getValidator();
    expect(validate(makeRequest({ headerKey: longKey }))).toBeNull();
  });
});
