export default function Page() {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>HairSnap Gemini Proxy</h1>
      <p>Gemini API 互換プロキシ — Stable-Hair (RunPod Serverless) バックエンド</p>
      <ul>
        <li><a href="/api/health">Health Check</a></li>
        <li><code>POST /api/v1beta/models/&#123;model&#125;:generateContent</code></li>
      </ul>
    </div>
  );
}
