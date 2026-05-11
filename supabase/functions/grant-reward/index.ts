// supabase/functions/grant-reward/index.ts
// リワード広告視聴完了後に生成回数ボーナスを付与する Edge Function。
//
// - 1日3回までの視聴上限を強制（クライアント側の不正防止）
// - usage_bonuses に INSERT（1レコード = +3回分の枠）
// - レスポンスで今日の残り視聴可能回数と残り生成回数を返す

import { createClient } from "jsr:@supabase/supabase-js@2";

const DAILY_BASE_LIMIT = 10;
const DAILY_REWARD_LIMIT = 3;
const BONUS_PER_REWARD = 3;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type, apikey",
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse(405, "serverError", "POST のみ受け付けます");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── 認証 ────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return errorResponse(401, "unauthorized", "ログインが必要です");
  }
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return errorResponse(401, "unauthorized", "JWT が無効または期限切れです");
  }

  // ── 日次集計 ─────────────────────────────────────────────
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  const [
    { count: usedCount },
    { count: bonusCount },
    { data: profile },
  ] = await Promise.all([
    supabase
      .from("ai_usage_logs")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("used_at", dayStart),
    supabase
      .from("usage_bonuses")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("granted_at", dayStart),
    supabase
      .from("profiles")
      .select("is_premium")
      .eq("id", user.id)
      .single(),
  ]);

  // プレミアムユーザーはリワード広告不要
  if (profile?.is_premium) {
    return errorResponse(400, "serverError", "プレミアムユーザーはリワード広告を使用できません");
  }

  // 1日の視聴上限チェック
  const todayRewardCount = bonusCount ?? 0;
  if (todayRewardCount >= DAILY_REWARD_LIMIT) {
    return errorResponse(429, "rewardLimitExceeded", "本日のリワード上限に達しました（3回/日）");
  }

  // ── ボーナス付与 ─────────────────────────────────────────
  const { error: insertError } = await supabase
    .from("usage_bonuses")
    .insert({ user_id: user.id });

  if (insertError) {
    console.error(insertError);
    return errorResponse(500, "serverError", "ボーナス付与に失敗しました");
  }

  // ── レスポンス計算 ───────────────────────────────────────
  const newBonusCount = todayRewardCount + 1;
  const bonusGranted = newBonusCount * BONUS_PER_REWARD;
  const effectiveLimit = DAILY_BASE_LIMIT + bonusGranted;
  const remaining = Math.max(0, effectiveLimit - (usedCount ?? 0));
  const rewardRemaining = DAILY_REWARD_LIMIT - newBonusCount;

  return new Response(
    JSON.stringify({
      remaining,
      reward_remaining: rewardRemaining,
      effective_limit: effectiveLimit,
    }),
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
