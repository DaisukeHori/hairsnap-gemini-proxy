/**
 * Integration tests for health endpoint
 */
import { describe, it, expect, vi } from 'vitest';

function makeMockNextServer() {
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
  return { NextResponse: MockNextResponse };
}

async function loadHealthRoute(backend?: string) {
  vi.resetModules();
  if (backend !== undefined) {
    process.env.BACKEND = backend;
  } else {
    delete process.env.BACKEND;
  }
  vi.doMock('next/server', () => makeMockNextServer());
  const { GET } = await import('../../app/api/health/route');
  return GET();
}

describe('Health Route Integration', () => {
  it('1: returns 200', async () => {
    const res = await loadHealthRoute('runpod');
    expect((res as any).status).toBe(200);
  });

  it('2: returns ok status', async () => {
    const res = await loadHealthRoute('runpod');
    expect((res as any).body.status).toBe('ok');
  });

  it('3: returns service name', async () => {
    const res = await loadHealthRoute('runpod');
    expect((res as any).body.service).toBe('hairsnap-gemini-proxy');
  });

  it('4: returns endpoints info', async () => {
    const res = await loadHealthRoute('runpod');
    expect((res as any).body.endpoints.generateContent).toContain('generateContent');
  });

  it('5: shows modal backend when BACKEND=modal', async () => {
    const res = await loadHealthRoute('modal');
    expect((res as any).body.backend).toBe('modal');
    expect((res as any).body.description).toContain('Modal');
  });

  it('6: shows runpod backend when BACKEND=runpod', async () => {
    const res = await loadHealthRoute('runpod');
    expect((res as any).body.backend).toBe('runpod');
    expect((res as any).body.description).toContain('RunPod');
  });

  it('7: defaults to runpod when BACKEND not set', async () => {
    const res = await loadHealthRoute(undefined);
    expect((res as any).body.backend).toBe('runpod');
  });

  it('8: description includes Serverless', async () => {
    const res = await loadHealthRoute('runpod');
    expect((res as any).body.description).toContain('Serverless');
  });

  it('9: description includes Gemini API', async () => {
    const res = await loadHealthRoute('runpod');
    expect((res as any).body.description).toContain('Gemini API');
  });

  it('10: endpoint path includes POST method', async () => {
    const res = await loadHealthRoute('runpod');
    expect((res as any).body.endpoints.generateContent).toContain('POST');
  });
});
