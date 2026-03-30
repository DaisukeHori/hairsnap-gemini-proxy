import { NextRequest, NextResponse } from 'next/server';

/**
 * Gemini SDK は API キーを以下のいずれかで送る:
 *   - Header: x-goog-api-key
 *   - Query param: key
 */
export function validateApiKey(request: NextRequest): NextResponse | null {
  const expectedKey = process.env.PROXY_API_KEY;
  if (!expectedKey) {
    console.warn('[auth] PROXY_API_KEY is not set — all requests accepted');
    return null;
  }

  const headerKey = request.headers.get('x-goog-api-key');
  const queryKey = request.nextUrl.searchParams.get('key');
  const provided = headerKey ?? queryKey;

  if (provided !== expectedKey) {
    return NextResponse.json(
      {
        error: {
          code: 401,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'UNAUTHENTICATED',
        },
      },
      { status: 401 },
    );
  }

  return null;
}
