/**
 * RunPod Serverless にリクエストを送信する。
 *
 * RunPod Serverless は以下の2つのエンドポイントを提供:
 *   POST /runsync  — 同期実行 (結果が返るまで待つ、最大30秒)
 *   POST /run      — 非同期実行 (ジョブIDを返す → /status/{id} でポーリング)
 *
 * Stable-Hair は 1.2〜4秒なので /runsync で十分。
 */

const RUNPOD_ENDPOINT_URL = process.env.RUNPOD_ENDPOINT_URL ?? '';
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY ?? '';
const RUNPOD_TIMEOUT_MS = parseInt(process.env.RUNPOD_TIMEOUT_MS ?? '30000', 10);

export interface StableHairInput {
  customerPhoto: Buffer;
  referencePhoto?: Buffer;
  additionalImages?: Buffer[];
  prompt: string;
  baldCacheKey: string;
  model: string;
}

export interface StableHairResult {
  imageBase64: string;
  latencyMs: number;
  estimatedCostUsd: number;
  model: string;
}

export async function callRunPodStableHair(
  input: StableHairInput,
): Promise<StableHairResult> {
  if (!RUNPOD_ENDPOINT_URL) {
    throw new Error('RUNPOD_ENDPOINT_URL is not configured');
  }

  const start = Date.now();

  const payload: Record<string, unknown> = {
    customer_photo: input.customerPhoto.toString('base64'),
    prompt: input.prompt,
    bald_cache_key: input.baldCacheKey,
  };

  if (input.referencePhoto) {
    payload.reference_photo = input.referencePhoto.toString('base64');
  }

  if (input.additionalImages?.length) {
    payload.additional_images = input.additionalImages.map((img) =>
      img.toString('base64'),
    );
  }

  const url = `${RUNPOD_ENDPOINT_URL}/runsync`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: payload }),
    signal: AbortSignal.timeout(RUNPOD_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`RunPod error (${response.status}): ${errorText}`);
  }

  const result = await response.json();

  // RunPod Serverless レスポンス形式:
  // { "id": "...", "status": "COMPLETED", "output": { ... } }
  if (result.status === 'FAILED') {
    throw new Error(`RunPod job failed: ${result.error ?? 'Unknown reason'}`);
  }

  if (result.status !== 'COMPLETED') {
    throw new Error(`RunPod unexpected status: ${result.status}`);
  }

  const output = result.output;
  const latencyMs = Date.now() - start;

  // GPU秒数からコスト推定 (RunPod 4090 Flex: $0.00035/s)
  const gpuSeconds = (output.gpu_time_ms ?? latencyMs) / 1000;
  const estimatedCostUsd = gpuSeconds * 0.00035;

  return {
    imageBase64: output.image,
    latencyMs,
    estimatedCostUsd,
    model: output.model ?? 'stable-hair-v1',
  };
}
