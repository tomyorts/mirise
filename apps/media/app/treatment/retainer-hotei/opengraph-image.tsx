import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "リテーナー(保定装置)は何年つける?やめたら・さぼったらどうなるか";

export default function Image() {
  return ogImage({ title: "リテーナー(保定装置)は何年つける?やめたら・さぼったらどうなるか", kicker: '治療法を正しく理解する' });
}
