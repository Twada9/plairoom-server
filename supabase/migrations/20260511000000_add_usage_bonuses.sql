-- usage_bonuses: リワード広告視聴による生成回数ボーナスを記録するテーブル
-- 1視聴 = 1レコード（+3回は Edge Function 側で計算）
-- 上限: 1日3視聴まで（grant-reward で強制）

CREATE TABLE IF NOT EXISTS usage_bonuses (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  granted_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS: ユーザーは自分のレコードのみ参照可。書き込みは Edge Function (service_role) のみ。
ALTER TABLE usage_bonuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_bonuses_select_own"
  ON usage_bonuses
  FOR SELECT
  USING (auth.uid() = user_id);

-- 検索パフォーマンス用インデックス（user_id + granted_at で日次集計クエリが速くなる）
CREATE INDEX IF NOT EXISTS idx_usage_bonuses_user_date
  ON usage_bonuses (user_id, granted_at);
