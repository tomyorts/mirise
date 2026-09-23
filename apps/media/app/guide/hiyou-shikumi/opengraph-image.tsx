import { ogImage, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '矯正の費用の仕組み:総額制と処置料別、追加費用の読み方';

export default function Image() {
  return ogImage({ title: '矯正の費用の仕組み:総額制と処置料別、追加費用の読み方', kicker: '意思決定ガイド' });
}
