// supabase/functions/generate-music/index.ts
// モック版: MusicGen の代わりに固定の音声URLを返す

import { createClient } from "jsr:@supabase/supabase-js@2";

// SoundHelix の無料サンプル音源（30秒前後）
const PLACEHOLDER_TRACKS = [
  { url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", duration: 30 },
  { url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3", duration: 29 },
  { url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3", duration: 30 },
  { url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3", duration: 28 },
  { url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3", duration: 30 },
];

Deno.serve(async (req: Request) => {
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
  const { room_id, prompt } = await req.json();
  if (!room_id || !prompt) {
    return errorResponse(400, "serverError", "room_id と prompt は必須です");
  }

  // ── 使用回数チェック ─────────────────────────────────────
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  const [{ count: usedCount }, { data: profile }, { count: bonusCount }] = await Promise.all([
    supabase
      .from("ai_usage_logs")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("used_at", dayStart),
    supabase
      .from("profiles")
      .select("is_premium")
      .eq("id", user.id)
      .single(),
    supabase
      .from("usage_bonuses")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("granted_at", dayStart),
  ]);

  const baseLimit = profile?.is_premium ? 100 : 10;
  const bonusGranted = (bonusCount ?? 0) * 3;
  const effectiveLimit = baseLimit + bonusGranted;

  if ((usedCount ?? 0) >= effectiveLimit) {
    return errorResponse(429, "usageLimitExceeded", "本日の生成回数上限に達しました");
  }

  // ── ① music_contents を generating で INSERT ─────────────
  const { data: content, error: insertError } = await supabase
    .from("music_contents")
    .insert({
      user_id: user.id,
      room_id,
      status: "generating",
      prompt_used: "",
      duration: 0,
    })
    .select()
    .single();

  if (insertError || !content) {
    console.error(insertError);
    return errorResponse(500, "serverError", "レコード作成に失敗しました");
  }

  const contentId: string = content.id;

  // ── ② モック: ランダムトラックを選択（50ms 待機）───────────
  await new Promise((r) => setTimeout(r, 50));

  const track = PLACEHOLDER_TRACKS[Math.floor(Math.random() * PLACEHOLDER_TRACKS.length)];
  const promptUsed = `[base_prompt] ${prompt}`;

  // ── ③ music_contents を pending に UPDATE ────────────────
  const { error: updateError } = await supabase
    .from("music_contents")
    .update({
      file_url: track.url,
      duration: track.duration,
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
    content_type: "music",
    used_at: new Date().toISOString(),
  });

  // ── ⑤ Realtime broadcast をバックグラウンドで送信 ──────────
  // レスポンスを返した後に実行される（await しない）
  (async () => {
    try {
      const channel = supabase.channel(`content-${contentId}`);
      await channel.subscribe();
      await channel.send({
        type: "broadcast",
        event: "content_updated",
        payload: {
          id: contentId,
          room_id: room_id,
          file_url: track.url,
          duration: track.duration,
          prompt_used: promptUsed,
          status: "pending",
        },
      });
      console.log(`📡 Broadcast sent for content: ${contentId}`);
      await channel.unsubscribe();
    } catch (broadcastError) {
      console.error(`❌ Broadcast failed for content ${contentId}:`, broadcastError);
    }
  })();

  // ── ⑥ content_id を返す ─────────────────────────────────
  return new Response(
    JSON.stringify({ content_id: contentId }),
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
