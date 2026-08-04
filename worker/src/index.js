export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const route = matchRoute(path);
    if (!route) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET" && route.verify) {
      return route.verify(request, url, env);
    }

    if (request.method === "POST" && route.receive) {
      return route.receive(request, url, env, ctx);
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

function matchRoute(path) {
  const routes = {
    "/webhook/instagram-hook": "instagram",
    "/webhook/facebook-hook": "facebook",
    "/webhook/whatsapp-hook": "whatsapp",
    "/webhook/line-hook": "line",
    "/webhook/tiktok-hook": "tiktok",
    "/webhook/wechat-hook": "wechat",
  };
  const key = routes[path];
  if (!key) return null;
  return {
    verify: key === "wechat" ? verifyWeChat : verifyMeta,
    receive: handlers[key],
  };
}

function verifyMeta(request, url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Verification failed", { status: 403 });
}

async function verifyWeChat(request, url, env) {
  const { signature, timestamp, nonce, echostr } = Object.fromEntries(url.searchParams);
  const arr = [env.WECHAT_TOKEN, timestamp, nonce].sort();
  const sha1 = await cryptoDigest("SHA-1", arr.join(""));
  if (sha1 === signature) {
    return new Response(echostr, { status: 200 });
  }
  return new Response("verification failed", { status: 403 });
}

const handlers = {
  instagram: async (request, url, env, ctx) => {
    const body = await request.json();
    const entry = body.entry && body.entry[0];
    const messaging = entry && entry.messaging && entry.messaging[0];
    const msg = messaging && messaging.message;
    if (!msg || msg.is_echo) {
      return json({});
    }
    if (!msg.text) {
      return json({});
    }
    ctx.waitUntil(
      postGraph(env, `${entry.id}/messages`, env.INSTAGRAM_ACCESS_TOKEN, {
        recipient: { id: messaging.sender.id },
        message: { text: env.INSTAGRAM_REPLY_TEXT || "Thanks for your Instagram message!" },
        message_type: "RESPONSE",
      })
    );
    return json({});
  },

  facebook: async (request, url, env, ctx) => {
    const body = await request.json();
    const entry = body.entry && body.entry[0];
    const messaging = entry && entry.messaging && entry.messaging[0];
    const msg = messaging && messaging.message;
    if (!msg || msg.is_echo) {
      return json({});
    }
    if (!msg.text) {
      return json({});
    }
    ctx.waitUntil(
      postGraph(env, "me/messages", env.FACEBOOK_PAGE_ACCESS_TOKEN, {
        recipient: { id: messaging.sender.id },
        message: { text: env.FACEBOOK_REPLY_TEXT || "Thanks for your Facebook message!" },
      })
    );
    return json({});
  },

  whatsapp: async (request, url, env, ctx) => {
    const body = await request.json();
    const entry = body.entry && body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const messages = value && value.messages;
    const inbound = messages && messages.filter((m) => m.type !== "text" || m.from);
    if (!inbound || inbound.length === 0) {
      return json({});
    }
    const message = inbound[0];
    if (message.type !== "text") {
      return json({});
    }
    ctx.waitUntil(
      postGraph(env, `${value.metadata.phone_number_id}/messages`, env.WHATSAPP_ACCESS_TOKEN, {
        messaging_product: "whatsapp",
        to: message.from,
        type: "text",
        text: { body: env.WHATSAPP_REPLY_TEXT || "Thanks for your message! This is an automated reply from your WhatsApp bot." },
      })
    );
    return json({});
  },

  line: async (request, url, env, ctx) => {
    const body = await request.json();
    const events = (body.events || []).filter((e) => e.type === "message" && e.message.type === "text" && e.replyToken);
    if (events.length === 0) {
      return json({});
    }
    const event = events[0];
    ctx.waitUntil(
      fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: env.LINE_REPLY_TEXT || "Thanks for your LINE message!" }],
        }),
      })
    );
    return json({});
  },

  tiktok: async (request, url, env, ctx) => {
    const body = await request.json();
    if (body.challenge_code) {
      return json({ challenge_code: body.challenge_code });
    }
    const message = body.data && body.data.message;
    const sender = body.data && body.data.sender;
    if (!message || !sender) {
      return json({});
    }
    ctx.waitUntil(
      fetch("https://open.tiktokapis.com/v2/message/send/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.TIKTOK_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          message_type: "text",
          text: env.TIKTOK_REPLY_TEXT || "Thanks for your TikTok message!",
          recipient: { open_id: sender.open_id },
        }),
      })
    );
    return json({});
  },

  wechat: async (request, url, env, ctx) => {
    const xml = await request.text();
    const parsed = parseWeChatXml(xml);
    if (parsed.msgType !== "text") {
      return textResponse("success");
    }
    const reply =
      "<xml>" +
      "<ToUserName><![CDATA[" + parsed.from + "]]></ToUserName>" +
      "<FromUserName><![CDATA[" + parsed.to + "]]></FromUserName>" +
      "<CreateTime>" + Math.floor(Date.now() / 1000) + "</CreateTime>" +
      "<MsgType><![CDATA[text]]></MsgType>" +
      "<Content><![CDATA[" + (env.WECHAT_REPLY_TEXT || "Thanks for your WeChat message!") + "]]></Content>" +
      "</xml>";
    return textResponse(reply);
  },
};

function parseWeChatXml(xml) {
  function get(tag) {
    const cdata = xml.match(new RegExp("<" + tag + "><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></" + tag + ">"));
    if (cdata) return cdata[1];
    const plain = xml.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
    return plain ? plain[1] : "";
  }
  return {
    to: get("ToUserName"),
    from: get("FromUserName"),
    msgType: get("MsgType"),
    content: get("Content"),
  };
}

async function postGraph(env, endpoint, token, payload) {
  return fetch(`https://graph.facebook.com/v19.0/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}

async function cryptoDigest(algo, text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest(algo, data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}
