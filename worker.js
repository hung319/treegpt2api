/**
 * =================================================================================
 * Project: treegpt-2api (Cloudflare Worker Edition)
 * Updated by: CezDev
 * Feature: Random Fake IP Headers for Anti-Ratelimit
 * =================================================================================
 */

// --- [Static Configuration] ---
const STATIC_CONFIG = {
  HEADERS: {
    "Host": "treegpt.app",
    "Origin": "https://treegpt.app",
    "Referer": "https://treegpt.app/",
    // User-Agent cơ bản (sẽ được random nhẹ version bên dưới)
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

// --- [Worker Entry] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Config runtime
    const config = {
      API_MASTER_KEY: env.API_MASTER_KEY || "1",
      UPSTREAM_API_URL: env.UPSTREAM_API_URL || "https://treegpt.app/api/chat-stream",
      ...STATIC_CONFIG
    };

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. Health Check
    if (url.pathname === '/') {
      return new Response(JSON.stringify({ 
        status: "ok", 
        service: "treegpt-proxy-rotating", 
        ip_mode: "fake-header-rotation" 
      }), {
        headers: corsHeaders({ "Content-Type": "application/json" })
      });
    }

    // 3. API Routing
    if (url.pathname.startsWith('/v1/')) {
      return handleApi(request, config);
    }

    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [IP Rotation Logic] ---

function getRandomIP() {
  // Sinh ngẫu nhiên 4 octet (tránh dải 0, 10, 127, 192, 172 để trông thật hơn)
  const part1 = Math.floor(Math.random() * 223) + 1; // 1-223
  const part2 = Math.floor(Math.random() * 255);
  const part3 = Math.floor(Math.random() * 255);
  const part4 = Math.floor(Math.random() * 255) + 1;
  return `${part1}.${part2}.${part3}.${part4}`;
}

function getDynamicHeaders(baseHeaders) {
  const fakeIP = getRandomIP();
  // Random nhẹ UserAgent version để tránh fingerprint tĩnh
  const randomChromeVer = Math.floor(Math.random() * 5) + 140; 
  const randomUA = baseHeaders["User-Agent"].replace("142", randomChromeVer.toString());

  console.log(`[Proxy] Using Fake IP: ${fakeIP}`);

  return {
    ...baseHeaders,
    "User-Agent": randomUA,
    // Các headers quan trọng để spoof IP
    "X-Forwarded-For": fakeIP,
    "X-Real-IP": fakeIP,
    "Client-IP": fakeIP,
    "True-Client-IP": fakeIP,
    "CF-Connecting-IP": fakeIP, // Đôi khi server target dùng header này
    "Forwarded": `for=${fakeIP};proto=https`
  };
}

// --- [Core Logic] ---

async function handleApi(request, config) {
  if (!verifyAuth(request, config)) {
    return createErrorResponse('Unauthorized. Invalid Bearer Token.', 401, 'unauthorized');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest(config);
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId, config);
  } else {
    return createErrorResponse(`Unsupported endpoint: ${url.pathname}`, 404, 'not_found');
  }
}

function verifyAuth(request, config) {
  const authHeader = request.headers.get('Authorization');
  if (config.API_MASTER_KEY === "1") return true; 
  return authHeader && authHeader === `Bearer ${config.API_MASTER_KEY}`;
}

function handleModelsRequest(config) {
  const modelsData = {
    object: 'list',
    data: config.MODELS.map(modelId => ({
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

async function handleChatCompletions(request, requestId, config) {
  try {
    const body = await request.clone().json();
    const model = body.model || config.DEFAULT_MODEL;
    const stream = body.stream !== false;

    const treeGptPayload = {
      messages: body.messages,
      model: model,
      autoRouteEnabled: false
    };

    // ==> LẤY HEADERS DYNAMIC CHO MỖI REQUEST <==
    const requestHeaders = getDynamicHeaders(config.HEADERS);

    // Fetch upstream
    const upstreamResponse = await fetch(config.UPSTREAM_API_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(treeGptPayload)
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      // Log lỗi để debug xem IP có bị chặn không
      console.warn(`[Upstream Error] Status: ${upstreamResponse.status} - Body: ${errorText.substring(0, 200)}`);
      return createErrorResponse(`Upstream Error (${upstreamResponse.status}): ${errorText}`, upstreamResponse.status, 'upstream_error');
    }

    // --- Stream Processing ---
    if (stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      (async () => {
        try {
          const reader = upstreamResponse.body.getReader();
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
                const data = JSON.parse(line);
                let content = data.content || "";
                const reasoning = data.reasoning || "";

                if (reasoning) {
                   const chunk = createChatCompletionChunk(requestId, model, reasoning);
                   await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                if (content) {
                   const chunk = createChatCompletionChunk(requestId, model, content);
                   await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              } catch (e) {}
            }
          }
          
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
      // --- Non-stream ---
      const text = await upstreamResponse.text();
      const lines = text.split('\n').filter(l => l.trim());
      let fullContent = "";
      
      for (const line of lines) {
          try {
              const data = JSON.parse(line);
              if (data.reasoning) fullContent += data.reasoning;
              if (data.content) fullContent += data.content;
          } catch(e) {}
      }

      return new Response(JSON.stringify({
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop"
        }],
      }), {
        headers: corsHeaders({ 'Content-Type': 'application/json' })
      });
    }

  } catch (e) {
    console.error("Worker Critical Error:", e);
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
