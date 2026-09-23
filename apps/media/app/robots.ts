import type { MetadataRoute } from 'next';
import { SITE } from '@/lib/site';

export const dynamic = 'force-static';

// ローンチ後の方針: AIクローラー(GPTBot/ClaudeBot等)をブロックしない(docs/media/06)。
// 現在はサイト全体がnoindex(layout.tsx)のため、robotsは補助的な位置づけ。
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${SITE.url}/sitemap.xml`,
  };
}
