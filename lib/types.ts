// --- Gemini API の型定義 ---

export interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string; // base64
  };
}

export interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

export interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig?: {
    responseModalities?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GeminiResponse {
  candidates: Array<{
    content: {
      role: string;
      parts: GeminiPart[];
    };
    finishReason: string;
  }>;
  modelVersion: string;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}
