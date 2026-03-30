/**
 * Gemini API 互換エンドポイント
 *
 * @google/genai SDK が送ってくるリクエストを受け取り、
 * Stable-Hair (RunPod Serverless) で処理して
 * Gemini フォーマットで返す。
 *
 * SDK は以下の URL にリクエストする:
 *   POST {baseUrl}/v1beta/models/{model}:generateContent
 *
 * このルートは /v1beta/models/[...path] でキャッチする。
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '../../../../../lib/auth';
import { processGenerateContent } from '../../../../../lib/generate-content';
import type { GeminiRequest } from '../../../../../lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  // --- 認証 ---
  const authError = validateApiKey(request);
  if (authError) return authError;

  // --- パスの解析 ---
  // path = ["stable-hair-v1:generateContent"] など
  const { path } = await params;
  const fullPath = path.join('/');

  // :generateContent で終わるかチェック
  if (!fullPath.endsWith(':generateContent')) {
    return NextResponse.json(
      {
        error: {
          code: 400,
          message: `Unsupported method. Path: ${fullPath}. Only :generateContent is supported.`,
          status: 'INVALID_ARGUMENT',
        },
      },
      { status: 400 },
    );
  }

  // モデル名を抽出 (例: "stable-hair-v1:generateContent" → "stable-hair-v1")
  const model = fullPath.replace(':generateContent', '');

  // --- リクエストボディの解析 ---
  let body: GeminiRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 400, message: 'Invalid JSON body', status: 'INVALID_ARGUMENT' } },
      { status: 400 },
    );
  }

  // --- 処理 ---
  try {
    const result = await processGenerateContent(model, body);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[generateContent ERROR]', message);
    return NextResponse.json(
      { error: { code: 500, message, status: 'INTERNAL' } },
      { status: 500 },
    );
  }
}
