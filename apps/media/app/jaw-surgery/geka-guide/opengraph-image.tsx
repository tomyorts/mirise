import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "顎変形症・外科矯正の完全ガイド:疑いから回復までの全ステップ";

export default function Image() {
  return ogImage({ title: "顎変形症・外科矯正の完全ガイド:疑いから回復までの全ステップ", kicker: '難症例・外科矯正' });
}
