// supabase/functions/patch-content-status/index.ts
// 投稿確定 / やり直しによるコンテンツ status 更新用 Edge Function。
// image_contents / music_contents テーブルは RLS で UPDATE が許可されていないため、
// service_role を持つこの Function 経由でのみ status を変更できる。
//
// 許可される遷移: pending → completed / failed のみ（自分のレコードのみ）

import { createClient } from "jsr:@supabase/supabase-js@2";

type ContentType = "image" | "music";
type TargetStatus = "completed" | "failed";

const TABLE_BY_CONTENT_TYPE: Record<ContentType, string> = {
  image: "image_contents",
  music: "music_contents",
};

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

  // ── 入力検証 ────────────────────────────────────────────
  let body: { content_id?: string; content_type?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "serverError", "リクエストボディの JSON 解析に失敗しました");
  }

  const { content_id, content_type, status } = body;
  if (!content_id || !content_type || !status) {
    return errorResponse(400, "serverError", "content_id, content_type, status は必須です");
  }
  if (content_type !== "image" && content_type !== "music") {
    return errorResponse(400, "serverError", "content_type は image / music のみ指定可能です");
  }
  if (status !== "completed" && status !== "failed") {
    return errorResponse(400, "serverError", "status は completed / failed のみ指定可能です");
  }

  const tableName = TABLE_BY_CONTENT_TYPE[content_type as ContentType];
  const targetStatus = status as TargetStatus;

  // ── 対象レコード取得 & 検証 ───────────────────────────
  const { data: existing, error: fetchError } = await supabase
    .from(tableName)
    .select("id, user_id, status")
    .eq("id", content_id)
    .maybeSingle();

  if (fetchError) {
    console.error(fetchError);
    return errorResponse(500, "serverError", "レコード取得に失敗しました");
  }
  if (!existing) {
    return errorResponse(404, "serverError", "対象のコンテンツが見つかりません");
  }
  if (existing.user_id !== user.id) {
    return errorResponse(403, "serverError", "他ユーザーのコンテンツは更新できません");
  }
  if (existing.status !== "pending") {
    return errorResponse(
      409,
      "serverError",
      `pending 以外のコンテンツは更新できません（現在: ${existing.status}）`,
    );
  }

  // ── 更新 ────────────────────────────────────────────────
  const { error: updateError } = await supabase
    .from(tableName)
    .update({ status: targetStatus })
    .eq("id", content_id);

  if (updateError) {
    console.error(updateError);
    return errorResponse(500, "serverError", "ステータス更新に失敗しました");
  }

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
