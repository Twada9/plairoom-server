// supabase/functions/check-usage-limit/index.ts
// 今日の生成残り回数とリワード残り回数を返す。
// iOS の生成画面で現在の使用状況を表示するために使用する。

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

  const isPremium = profile?.is_premium ?? false;
  const baseLimit = isPremium ? 100 : DAILY_BASE_LIMIT;
  const todayBonusCount = bonusCount ?? 0;
  const bonusGranted = todayBonusCount * BONUS_PER_REWARD;
  const effectiveLimit = baseLimit + (isPremium ? 0 : bonusGranted);
  const used = usedCount ?? 0;
  const remaining = Math.max(0, effectiveLimit - used);
  const rewardRemaining = isPremium ? 0 : Math.max(0, DAILY_REWARD_LIMIT - todayBonusCount);

  return new Response(
    JSON.stringify({
      used,
      limit: effectiveLimit,
      remaining,
      is_premium: isPremium,
      reward_remaining: rewardRemaining,
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
