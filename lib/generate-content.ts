/**
 * Gemini API リクエストを受け取り、Stable-Hair (RunPod Serverless) で処理して
 * Gemini API レスポンスフォーマットで返す。
 *
 * Gemini SDK が送ってくる parts の構造:
 *   parts[0]: inlineData (顧客写真)
 *   parts[1]: inlineData (参照ヘアスタイル画像) — オプション
 *   parts[2]: inlineData (追加画像: 確定済みfront等) — オプション
 *   parts[N]: text (プロンプト)
 */

import type {
  GeminiRequest,
  GeminiResponse,
  GeminiPart,
} from './types';
import { callRunPodStableHair } from './runpod-client';

interface ExtractedInput {
  images: Buffer[];
  prompt: string;
}

function extractFromParts(parts: GeminiPart[]): ExtractedInput {
  const images: Buffer[] = [];
  let prompt = '';

  for (const part of parts) {
    if (part.inlineData?.data) {
      images.push(Buffer.from(part.inlineData.data, 'base64'));
    }
    if (part.text) {
      prompt += (prompt ? '\n' : '') + part.text;
    }
  }

  return { images, prompt };
}

export async function processGenerateContent(
  model: string,
  body: GeminiRequest,
): Promise<GeminiResponse> {
  // contents から全 parts を収集
  const allParts = body.contents.flatMap((c) => c.parts);
  const { images, prompt } = extractFromParts(allParts);

  if (images.length === 0) {
    throw new Error('No image provided in request. At least one image (customer photo) is required.');
  }

  // images[0] = 顧客写真, images[1] = 参照ヘア, images[2+] = 追加画像
  const customerPhoto = images[0];
  const referencePhoto = images.length > 1 ? images[1] : undefined;
  const additionalImages = images.length > 2 ? images.slice(2) : undefined;

  // Bald キャッシュキーの生成 (顧客写真のハッシュ)
  const crypto = await import('crypto');
  const baldCacheKey = crypto
    .createHash('sha256')
    .update(customerPhoto)
    .digest('hex')
    .slice(0, 16);

  // RunPod Serverless に送信
  const result = await callRunPodStableHair({
    customerPhoto,
    referencePhoto,
    additionalImages,
    prompt,
    baldCacheKey,
    model,
  });

  // Gemini API フォーマットでレスポンスを構築
  const responseParts: GeminiPart[] = [];

  // 生成画像を返す
  responseParts.push({
    inlineData: {
      mimeType: 'image/jpeg',
      data: result.imageBase64,
    },
  });

  // テキストメタデータも返す（Gemini と同じく Text + Image）
  responseParts.push({
    text: JSON.stringify({
      model: result.model,
      latencyMs: result.latencyMs,
      estimatedCostUsd: result.estimatedCostUsd,
      baldCacheKey,
    }),
  });

  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: responseParts,
        },
        finishReason: 'STOP',
      },
    ],
    modelVersion: result.model,
    usageMetadata: {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    },
  };
}
