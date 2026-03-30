import { NextResponse } from 'next/server';

const BACKEND = process.env.BACKEND ?? 'runpod';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'hairsnap-gemini-proxy',
    backend: BACKEND,
    description: `Gemini API compatible proxy backed by Stable-Hair on ${BACKEND === 'modal' ? 'Modal' : 'RunPod'} Serverless`,
    endpoints: {
      generateContent: 'POST /v1beta/models/{model}:generateContent',
    },
  });
}
