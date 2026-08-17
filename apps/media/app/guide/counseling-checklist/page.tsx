import type { Metadata } from 'next';
import { abs } from '@/lib/site';
import Link from 'next/link';
import Breadcrumbs from '@/components/Breadcrumbs';
import PrintButton from '@/components/PrintButton';

export const metadata: Metadata = {
  title: '矯正カウンセリング準備チェックリスト(印刷・持参用)',
  description:
    'カウンセリング前に確認しておくこと、当日に必ず聞くべき質問、持ち物を1枚にまとめた準備チェックリスト。印刷して持参できます。',
  alternates: { canonical: abs('/guide/counseling-checklist/') },
};

const BRING = [
  '健康保険証(顎変形症等で保険適用の可能性がある場合)',
  '他院の検査資料・治療計画書(セカンドオピニオンの場合)',
  '気になっている点・治したい点を書き出したメモ',
  '予算の上限と、支払い方法の希望',
  '通院可能な曜日・時間帯',
];

const ASK_DIAGNOSIS = [
  '私の不正咬合の原因は、歯の位置ですか、骨格ですか(歯性か骨格性か)',
  '診断のためにどんな検査をしますか。費用はいくらですか',
  '治療のゴール(噛み合わせ・横顔)はどうなりますか',
];

const ASK_PLAN = [
  '抜歯は必要ですか。必要ならその理由と、抜かない場合との違いは',
  '手術は必要ですか。必要ならその理由は',
  '装置は何を使いますか。ほかの選択肢はありますか',
  '治療期間はどのくらいで、その根拠は何ですか',
  '治療のリスク・副作用と、後戻りの可能性は',
];

const ASK_MONEY = [
  '総額はいくらですか。何が含まれ、何が別料金ですか',
  '追加費用が発生するのはどんなときですか',
  '支払い方法(分割・デンタルローン)はありますか',
  '顎変形症などで健康保険が使える可能性はありますか',
];

const ASK_SYSTEM = [
  '治療計画書は書面でもらえますか',
  '途中で転院・中断する場合の精算はどうなりますか',
  '担当医は変わりませんか。急なトラブル時の対応は',
];

function Group({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="checklist-group">
      <h3>{title}</h3>
      <ul className="checklist">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </section>
  );
}

export default function ChecklistPage() {
  return (
    <>
      <Breadcrumbs
        items={[
          { label: '意思決定ガイド', href: '/guide/' },
          { label: 'カウンセリング準備チェックリスト' },
        ]}
      />
      <div className="container">
        <header className="page-header">
          <p className="eyebrow">CHECKLIST</p>
          <h1>矯正カウンセリング準備チェックリスト</h1>
          <p className="page-lead">
            カウンセリングは、あなたが医院を見極める場でもあります。当日に慌てないよう、確認すること・聞くこと・持ち物を1枚にまとめました。
          </p>
          <PrintButton label="印刷して持参する(Ctrl / ⌘ + P)" event="checklist_download" />
        </header>

        <div className="checklist-sheet">
          <Group title="① 持ち物" items={BRING} />
          <Group title="② 診断について聞くこと" items={ASK_DIAGNOSIS} />
          <Group title="③ 治療計画について聞くこと" items={ASK_PLAN} />
          <Group title="④ 費用について聞くこと" items={ASK_MONEY} />
          <Group title="⑤ 体制について聞くこと" items={ASK_SYSTEM} />
        </div>

        <p className="note">
          各質問の「良い回答・注意すべき回答」の見分け方は
          <Link href="/guide/counseling-questions/">カウンセリングで聞くべき15の質問</Link>
          で解説しています。診断結果に迷いが残ったら
          <Link href="/guide/second-opinion/">セカンドオピニオン</Link>
          という選択肢もあります。
        </p>
      </div>
    </>
  );
}
