import { ImageResponse } from 'next/og';
import { readFileSync } from 'fs';
import { join } from 'path';

// OGP画像(SNS/AI検索カード)の共通レンダラ。
// 日本語表示のためIPAゴシックのサブセット(assets/fonts/ipagp-og.ttf)を埋め込む。
export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

const fontData = readFileSync(join(process.cwd(), 'assets/fonts/ipagp-og.ttf'));

const ACCENT = '#175e66';
const INK = '#1a2b2b';
const FAINT = '#5a6b6b';

export function ogImage({ title, kicker }: { title: string; kicker?: string }) {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#ffffff',
          padding: '72px 80px',
          fontFamily: 'IPAGothic',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 14, background: ACCENT }} />

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {kicker ? (
            <div
              style={{
                display: 'flex',
                alignSelf: 'flex-start',
                background: '#eaf3f3',
                color: ACCENT,
                fontSize: 30,
                padding: '8px 22px',
                borderRadius: 999,
                marginBottom: 34,
              }}
            >
              {kicker}
            </div>
          ) : null}
          <div style={{ display: 'flex', color: INK, fontSize: 62, lineHeight: 1.32, fontWeight: 700 }}>
            {title}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '2px solid #e3ecec',
            paddingTop: 28,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', color: ACCENT, fontSize: 34, fontWeight: 700 }}>
              キョウセイの前に
            </div>
            <div style={{ display: 'flex', color: FAINT, fontSize: 24, marginTop: 4 }}>
              矯正治療の意思決定ガイド
            </div>
          </div>
          <div style={{ display: 'flex', color: FAINT, fontSize: 24 }}>
            歯科医師 実名監修:富田大介 院長
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [{ name: 'IPAGothic', data: fontData as unknown as ArrayBuffer, style: 'normal', weight: 400 }],
    }
  );
}
