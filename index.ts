/**
 * =================================================================================
 * Project: treegpt-2api (Bun Edition)
 * Version: 1.0.1 (Refactored by CezDev)
 * Runtime: Bun v1.x
 * Description: TreeGPT to OpenAI API Proxy (Headless)
 * =================================================================================
 */

// --- [Configuration] ---
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_ORIGIN: process.env.UPSTREAM_ORIGIN || "https://treegpt.app",
  UPSTREAM_API_URL: process.env.UPSTREAM_API_URL || "https://treegpt.app/api/chat-stream",
  
  // Headers giả lập Chrome 142 để bypass bot protection đơn giản
  HEADERS: {
    "Host": "treegpt.app",
    "Origin": "https://treegpt.app",
    "Referer": "https://treegpt.app/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  },

  MODELS: [
    "qwen-3-32b",
    "deepseek-reasoner",
    "deepseek-chat",
    "llama-3.3-70b",
    "llama-3.1-8b",
    "llama-4-scout-17b-16e-instruct"
  ],
  DEFAULT_MODEL: "qwen-3-32b"
};

// --- [Server Entry] ---
console.log(`🌲 TreeGPT API Proxy running on http://localhost:${CONFIG.PORT}`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. CORS Preflight
    if (req.method === 'OPTIONS') return handleCorsPreflight();

    // 2. Health Check (Thay thế cho UI cũ)
    if (url.pathname === '/') {
      return new Response(JSON.stringify({ status: "ok", service: "treegpt-2api-bun", version: "1.0.1" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3. API Routing
    if (url.pathname.startsWith('/v1/')) {
      return handleApi(req);
    }

    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  }
});

// --- [Core Logic] ---

async function handleApi(request) {
  if (!verifyAuth(request)) {
    return createErrorResponse('Unauthorized. Invalid Bearer Token.', 401, 'unauthorized');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`Unsupported endpoint: ${url.pathname}`, 404, 'not_found');
  }
}

function verifyAuth(request) {
  const authHeader = request.headers.get('Authorization');
  if (CONFIG.API_MASTER_KEY === "1") return true; // Debug mode
  return authHeader && authHeader === `Bearer ${CONFIG.API_MASTER_KEY}`;
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'treegpt',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const stream = body.stream !== false;

    // Payload cho TreeGPT
    const treeGptPayload = {
      messages: body.messages,
      model: model,
      autoRouteEnabled: false
    };

    // Proxy request
    const response = await fetch(CONFIG.UPSTREAM_API_URL, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(treeGptPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return createErrorResponse(`Upstream Error (${response.status}): ${errorText}`, response.status, 'upstream_error');
    }

    // Stream Handling (NDJSON -> SSE)
    if (stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      // Xử lý nền (Background processing)
      (async () => {
        try {
          // Bun's fetch returns a standard ReadableStream
          const reader = response.body.getReader();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              
              try {
                // Parse NDJSON
                const data = JSON.parse(line);
                let content = data.content || "";
                const reasoning = data.reasoning || "";

                // Ưu tiên gửi reasoning trước nếu có
                if (reasoning) {
                   const reasoningChunk = createChatCompletionChunk(requestId, model, reasoning);
                   // Format theo deepseek reasoning (optional) hoặc gộp vào content
                   // Ở đây tôi gộp vào content để tương thích client OpenAI tiêu chuẩn
                   await writer.write(encoder.encode(`data: ${JSON.stringify(reasoningChunk)}\n\n`));
                }

                if (content) {
                   const contentChunk = createChatCompletionChunk(requestId, model, content);
                   await writer.write(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
                }

              } catch (e) {
                // Skip parse errors (common in streams)
              }
            }
          }
          
          // Kết thúc
          const endChunk = createChatCompletionChunk(requestId, model, "", "stop");
          await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
          await writer.write(encoder.encode('data: [DONE]\n\n'));

        } catch (e) {
          console.error("Stream Error:", e);
          const errChunk = createChatCompletionChunk(requestId, model, `\n\n[Error: ${e.message}]`, "stop");
          await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: corsHeaders({ 
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Trace-ID': requestId
        })
      });

    } else {
      // Non-stream fallback
      const text = await response.text();
      const lines = text.split('\n').filter(l => l.trim());
      let fullContent = "";
      
      for (const line of lines) {
          try {
              const data = JSON.parse(line);
              if (data.reasoning) fullContent += data.reasoning;
              if (data.content) fullContent += data.content;
          } catch(e) {}
      }

      const resp = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop"
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      return new Response(JSON.stringify(resp), {
        headers: corsHeaders({ 'Content-Type': 'application/json' })
      });
    }

  } catch (e) {
    console.error("Server Error:", e);
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- [Helpers] ---

function createChatCompletionChunk(id, model, content, finishReason = null) {
  return {
    id: id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: content ? { content: content } : {}, finish_reason: finishReason }]
  };
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
