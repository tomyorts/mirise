import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "顎変形症の手術に高額療養費制度は使える?対象範囲・手続き・限度額適用認定証";

export default function Image() {
  return ogImage({ title: "顎変形症の手術に高額療養費制度は使える?対象範囲・手続き・限度額適用認定証", kicker: '意思決定ガイド' });
}
