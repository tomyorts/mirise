'use client';

import { SITE } from '@/lib/site';
import { track, getFirstTouch } from '@/lib/analytics';

// 相談導線(CV)。静的サイトのため送信先を持つフォームは置かず、
// 既存クリニックの実チャネル(電話・WEB予約・LINE)へ確実につなぐ。
// 電話は即時有効。WEB予約/LINEは環境変数でURLを与えると自動で表示・計測される。
const RESERVE_URL = process.env.NEXT_PUBLIC_RESERVE_URL || '';
const LINE_URL = process.env.NEXT_PUBLIC_LINE_URL || '';

export default function ConsultContact({
  consultType,
}: {
  consultType: 'so' | 'complex' | 'general';
}) {
  const tel = SITE.operator.tel;
  const fire = (method: string) =>
    track('consult_contact_click', {
      consult_type: consultType,
      method,
      first_article: getFirstTouch(),
    });

  return (
    <div className="consult-contact">
      <div className="consult-buttons">
        <a
          className="cta-button"
          href={`tel:${tel.replace(/[^0-9]/g, '')}`}
          onClick={() => fire('tel')}
        >
          電話で相談・予約する({tel})
        </a>
        {RESERVE_URL && (
          <a
            className="cta-button secondary"
            href={RESERVE_URL}
            onClick={() => fire('web_reserve')}
            target="_blank"
            rel="noopener noreferrer"
          >
            WEBで予約する
          </a>
        )}
        {LINE_URL && (
          <a
            className="cta-button secondary"
            href={LINE_URL}
            onClick={() => fire('line')}
            target="_blank"
            rel="noopener noreferrer"
          >
            LINEで相談する
          </a>
        )}
      </div>
      <p className="consult-note">
        受付時間: 火〜日 10:00〜19:00(最終受付18:30・月曜・祝日休診)。
        {(!RESERVE_URL || !LINE_URL) &&
          ' ※WEB予約・LINE相談の導線は公開時に有効化されます。'}
      </p>
    </div>
  );
}
