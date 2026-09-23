import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "大人の歯列矯正は医療費控除の対象になる?条件・計算・申請の実務";

export default function Image() {
  return ogImage({ title: "大人の歯列矯正は医療費控除の対象になる?条件・計算・申請の実務", kicker: '意思決定ガイド' });
}
