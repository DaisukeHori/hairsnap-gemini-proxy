import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'hairsnap-gemini-proxy',
    description: 'Gemini API compatible proxy backed by Stable-Hair on RunPod Serverless',
    endpoints: {
      generateContent: 'POST /v1beta/models/{model}:generateContent',
    },
  });
}
