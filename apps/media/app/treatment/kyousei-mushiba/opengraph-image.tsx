import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "矯正中に虫歯になったらどうなる?治療の流れと装置の一時撤去";

export default function Image() {
  return ogImage({ title: "矯正中に虫歯になったらどうなる?治療の流れと装置の一時撤去", kicker: '治療法を正しく理解する' });
}
