/**
 * Modal Serverless にリクエストを送信する。
 *
 * Modalは標準HTTP POSTエンドポイントを提供。
 * RunPodのような /runsync ラッパーは不要で、直接JSONを送れる。
 */

const MODAL_ENDPOINT_URL = process.env.MODAL_ENDPOINT_URL ?? '';
const MODAL_TIMEOUT_MS = parseInt(process.env.MODAL_TIMEOUT_MS ?? '60000', 10);

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

export async function callModalStableHair(
  input: StableHairInput,
): Promise<StableHairResult> {
  if (!MODAL_ENDPOINT_URL) {
    throw new Error('MODAL_ENDPOINT_URL is not configured');
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

  // Modalは直接POSTでJSON送信（RunPodのような {input: ...} ラッパー不要）
  const response = await fetch(MODAL_ENDPOINT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Modal error (${response.status}): ${errorText}`);
  }

  const output = await response.json();

  if (output.error) {
    throw new Error(`Modal job failed: ${output.error}`);
  }

  const latencyMs = Date.now() - start;

  // Modal A10G: ~$0.000342/s
  const gpuSeconds = (output.gpu_time_ms ?? latencyMs) / 1000;
  const estimatedCostUsd = gpuSeconds * 0.000342;

  return {
    imageBase64: output.image,
    latencyMs,
    estimatedCostUsd,
    model: output.model ?? 'stable-hair-v1',
  };
}
