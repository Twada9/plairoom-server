// supabase/functions/generate-image/index.ts
// モック版: Hugging Face の代わりにプレースホルダー画像URLを返す

import { createClient } from "jsr:@supabase/supabase-js@2";

const PLACEHOLDER_SEEDS = [
  "nature1", "nature2", "city1", "city2", "abstract1",
  "abstract2", "landscape1", "landscape2", "art1", "art2",
];

function placeholderImageUrl(seed: string): string {
  return `https://picsum.photos/seed/${seed}/800/600`;
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type, apikey",
      },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── 認証チェック ──────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return errorResponse(401, "unauthorized", "ログインが必要です");
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return errorResponse(401, "unauthorized", "JWT が無効または期限切れです");
  }

  // ── リクエストボディ ──────────────────────────────────────
  const { room_id, prompt, user_id, request_id } = await req.json();
  if (!room_id || !prompt || !user_id || !request_id) {
    return errorResponse(400, "serverError", "room_id, prompt, user_id, request_id は必須です");
  }

  // ── 使用回数チェック ─────────────────────────────────────
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { count } = await supabase
    .from("ai_usage_logs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("used_at", monthStart);

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_premium")
    .eq("id", user.id)
    .single();

  const limit = profile?.is_premium ? 100 : 10;
  if ((count ?? 0) >= limit) {
    return errorResponse(429, "usageLimitExceeded", "月の生成回数上限に達しました");
  }

  // ── ① image_contents を generating で INSERT ─────────────
  const { data: content, error: insertError } = await supabase
    .from("image_contents")
    .insert({
      user_id: user.id,
      room_id,
      status: "generating",
      prompt_used: "",
    })
    .select()
    .single();

  if (insertError || !content) {
    console.error(insertError);
    return errorResponse(500, "serverError", "レコード作成に失敗しました");
  }

  const contentId: string = content.id;

  // ── ② モック: ランダムプレースホルダーURLを選択（50ms 待機でAI処理を模倣）──
  await new Promise((r) => setTimeout(r, 50));

  const seed = PLACEHOLDER_SEEDS[Math.floor(Math.random() * PLACEHOLDER_SEEDS.length)];
  const fileUrl = placeholderImageUrl(seed);
  const promptUsed = `[base_prompt] ${prompt}`;

  // ── ③ image_contents を pending に UPDATE ────────────────
  const { error: updateError } = await supabase
    .from("image_contents")
    .update({
      file_url: fileUrl,
      status: "pending",
      prompt_used: promptUsed,
    })
    .eq("id", contentId);

  if (updateError) {
    console.error(updateError);
    return errorResponse(500, "serverError", "レコード更新に失敗しました");
  }

  // ── ④ ai_usage_logs に記録 ───────────────────────────────
  await supabase.from("ai_usage_logs").insert({
    user_id: user.id,
    content_type: "image",
    used_at: new Date().toISOString(),
  });

  // ── ⑤ Realtime broadcast を送信（同期実行） ──────────
  try {
    const channel = supabase.channel(`user:${user_id}:${request_id}`, {
      config: { private: true }
    });
    await channel.subscribe();
    await new Promise((resolve) => setTimeout(resolve, 10000))
    await channel.send({
      type: "broadcast",
      event: "content_updated",
      payload: {
        id: contentId,
        room_id: room_id,
        file_url: fileUrl,
        prompt_used: promptUsed,
        status: "pending",
      },
    });
    console.log(`📡 Broadcast sent for user:${user_id}:${request_id}`);
    await channel.unsubscribe();
  } catch (broadcastError) {
    console.error(`❌ Broadcast failed for user:${user_id}:${request_id}:`, broadcastError);
    // エラーでもレスポンスは返す（クライアント側でタイムアウト処理）
  }

  // ── ⑥ シンプルなレスポンスを返す ────────────────────
  return new Response(
    JSON.stringify({ success: true }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
});

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { type, message } }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
