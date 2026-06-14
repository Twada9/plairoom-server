// supabase/functions/generate-image/index.ts
// Pollinations.ai で画像生成し Supabase Storage に保存する

import { createClient } from "jsr:@supabase/supabase-js@2";

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
  const { room_id, prompt, request_id } = await req.json();
  if (!room_id || !prompt || !request_id) {
    return errorResponse(400, "serverError", "room_id, prompt, request_id は必須です");
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

  // ── ② ai_usage_logs に記録 ───────────────────────────────
  await supabase.from("ai_usage_logs").insert({
    user_id: user.id,
    content_type: "image",
    used_at: new Date().toISOString(),
  });

  // ── ③ バックグラウンドで画像生成・保存・broadcast ────────
  (async () => {
    try {
      // Pollinations.ai で画像生成
      const pollinationsUrl =
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
        `?width=800&height=600&nologo=true&seed=${Date.now()}`;

      const pollinationsToken = Deno.env.get("POLLINATIONS_TOKEN");
      const imageResponse = await fetch(pollinationsUrl, {
        headers: pollinationsToken
          ? { "Authorization": `Bearer ${pollinationsToken}` }
          : {},
      });
      if (!imageResponse.ok) {
        throw new Error(`Pollinations.ai エラー: ${imageResponse.status}`);
      }

      // Supabase Storage にアップロード
      const imageBuffer = await imageResponse.arrayBuffer();
      const storagePath = `${user.id}/${contentId}.jpg`;

      const { error: uploadError } = await supabase.storage
        .from("images")
        .upload(storagePath, imageBuffer, { contentType: "image/jpeg" });

      if (uploadError) throw uploadError;

      // 公開 URL 取得
      const { data: { publicUrl } } = supabase.storage
        .from("images")
        .getPublicUrl(storagePath);

      // image_contents を pending に UPDATE
      const { error: updateError } = await supabase
        .from("image_contents")
        .update({
          file_url: publicUrl,
          status: "pending",
          prompt_used: prompt,
        })
        .eq("id", contentId);

      if (updateError) throw updateError;

      // broadcast 送信
      const channel = supabase.channel(`user:${user.id}:${request_id}`, {
        config: { private: true },
      });
      await channel.subscribe();
      await channel.send({
        type: "broadcast",
        event: "content_updated",
        payload: {
          id: contentId,
          room_id,
          file_url: publicUrl,
          prompt_used: prompt,
          status: "pending",
        },
      });
      console.log(`📡 Broadcast sent for user:${user.id}:${request_id}`);
      await channel.unsubscribe();
    } catch (error) {
      console.error(`❌ Image generation failed for content ${contentId}:`, error);

      // エラーステータスに更新
      await supabase
        .from("image_contents")
        .update({ status: "error" })
        .eq("id", contentId);

      // エラーを broadcast で通知
      try {
        const channel = supabase.channel(`user:${user.id}:${request_id}`, {
          config: { private: true },
        });
        await channel.subscribe();
        await channel.send({
          type: "broadcast",
          event: "content_updated",
          payload: { id: contentId, status: "error" },
        });
        await channel.unsubscribe();
      } catch (broadcastError) {
        console.error(`❌ Error broadcast failed:`, broadcastError);
      }
    }
  })();

  // ── ④ 即時レスポンスを返す ───────────────────────────────
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
