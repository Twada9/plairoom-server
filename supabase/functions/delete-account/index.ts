// supabase/functions/delete-account/index.ts
// 退会処理: パスワード再認証後に Storage ファイル・DB レコード・Auth ユーザーを完全削除する。
//
// 処理フロー:
// ① JWT 検証でユーザーを特定
// ② リクエスト email が JWT の user.email と一致するか確認
// ③ email + password で再認証（signInWithPassword）
// ④ Storage images/{user_id}/ 配下を全件削除（ページネーション対応）
// ⑤ auth.admin.deleteUser(user_id) → profiles 起点の CASCADE で DB レコード連鎖削除
// ⑥ { success: true } を返す

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

  if (req.method !== "POST") {
    return errorResponse(405, "serverError", "POST のみ受け付けます");
  }

  // service_role クライアント: auth.getUser / Storage 操作 / auth.admin.deleteUser に使用
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── ① JWT 検証 ──────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return errorResponse(401, "unauthorized", "ログインが必要です");
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return errorResponse(401, "unauthorized", "JWT が無効または期限切れです");
  }

  // ── リクエストボディ解析 ─────────────────────────────────────
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "serverError", "リクエストボディの JSON 解析に失敗しました");
  }

  const { email, password } = body;
  if (!email || !password) {
    return errorResponse(400, "serverError", "email と password は必須です");
  }

  // ── ② メールアドレス一致確認 ─────────────────────────────────
  if (email !== user.email) {
    return errorResponse(401, "invalidCredentials", "メールアドレスが一致しません");
  }

  // ── ③ パスワード再認証 ────────────────────────────────────────
  // anon クライアント: signInWithPassword は anon key で実行（service_role では再認証の意味がない）
  const supabaseAnon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

  const { error: signInError } = await supabaseAnon.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) {
    return errorResponse(401, "invalidCredentials", "パスワードが正しくありません");
  }

  // ── ④ Storage ファイル削除 ────────────────────────────────────
  // images/{user_id}/ 配下を 100 件ずつページネーションして全件削除する
  const BUCKET = "images";
  const prefix = `${user.id}/`;

  try {
    let offset = 0;
    const PAGE_SIZE = 100;

    while (true) {
      const { data: files, error: listError } = await supabaseAdmin.storage
        .from(BUCKET)
        .list(prefix, { limit: PAGE_SIZE, offset });

      if (listError) {
        console.error("Storage list error:", listError);
        return errorResponse(500, "serverError", "Storage ファイル一覧取得に失敗しました");
      }

      if (!files || files.length === 0) break;

      const paths = files.map((f) => `${prefix}${f.name}`);
      const { error: removeError } = await supabaseAdmin.storage
        .from(BUCKET)
        .remove(paths);

      if (removeError) {
        console.error("Storage remove error:", removeError);
        return errorResponse(500, "serverError", "Storage ファイル削除に失敗しました");
      }

      if (files.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  } catch (e) {
    console.error("Storage deletion unexpected error:", e);
    return errorResponse(500, "serverError", "Storage 削除中に予期しないエラーが発生しました");
  }

  // ── ⑤ Auth ユーザー削除（→ DB CASCADE 連鎖削除） ──────────────
  const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(user.id);
  if (deleteUserError) {
    console.error("deleteUser error:", deleteUserError);
    return errorResponse(500, "serverError", "ユーザー削除に失敗しました");
  }

  // ── ⑥ 成功レスポンス ─────────────────────────────────────────
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
