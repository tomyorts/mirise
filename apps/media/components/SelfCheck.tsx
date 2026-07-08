'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ARTICLES, articlePath, CATEGORY_LABEL } from '@/lib/articles';

// CVの中核ツール。3問で「読むべき記事」と「相談すべきか」を出し分ける。
// 医療広告配慮: 診断ではなく記事案内であることを明記し、症状の重さを判定しない。

type Q1 = 'a' | 'b' | 'c' | 'd';
type Q2 = 'ukeguchi' | 'kaikou' | 'dekoboko' | 'surihetsu';
type Q3 = 'surgery' | 'basshi' | 'hiyou' | 'none';

const Q1_OPTIONS: { value: Q1; label: string }[] = [
  { value: 'a', label: 'まだ歯科医院には行っていない(情報収集中)' },
  { value: 'b', label: 'カウンセリングを受けた・治療計画を提示された' },
  { value: 'c', label: 'いま矯正治療中で、不安や迷いがある' },
  { value: 'd', label: '以前矯正した(後戻り・仕上がりが気になる)' },
];

const Q2_OPTIONS: { value: Q2; label: string }[] = [
  { value: 'ukeguchi', label: '受け口・顎のずれ・顔の左右非対称' },
  { value: 'kaikou', label: '前歯が閉じない・うまく噛めない' },
  { value: 'dekoboko', label: '出っ歯・歯のでこぼこ・口元の突出' },
  { value: 'surihetsu', label: '噛み合わせ全体のすり減り・崩れ' },
];

const Q3_OPTIONS: { value: Q3; label: string }[] = [
  { value: 'surgery', label: '手術が必要と言われた/手術になるのが不安' },
  { value: 'basshi', label: '抜歯が必要と言われた/歯を抜きたくない' },
  { value: 'hiyou', label: '費用・保険が使えるかが気になる' },
  { value: 'none', label: '特にない・まず全体像を知りたい' },
];

const Q2_ARTICLES: Record<Q2, string[]> = {
  ukeguchi: ['/jaw-surgery/ukeguchi-shindan/', '/jaw-surgery/hoken-tekiyo/', '/jaw-surgery/ganmen-hitaishou/'],
  kaikou: ['/jaw-surgery/kaikou/', '/jaw-surgery/hoken-tekiyo/'],
  dekoboko: ['/treatment/basshi-hibassi/', '/faq/hibassi-genkai/', '/faq/kao-kawaru/'],
  surihetsu: ['/jaw-surgery/kougou-saiken/', '/faq/otona-nenrei/'],
};

const Q3_ARTICLES: Record<Q3, string[]> = {
  surgery: ['/jaw-surgery/geka-nagare/', '/jaw-surgery/geka-risk/', '/jaw-surgery/surgery-first/'],
  basshi: ['/treatment/basshi-hibassi/', '/faq/hibassi-genkai/'],
  hiyou: ['/guide/hiyou-shikumi/', '/jaw-surgery/hoken-tekiyo/'],
  none: ['/guide/10-questions/'],
};

const Q1_ARTICLES: Record<Q1, string[]> = {
  a: ['/guide/counseling-questions/'],
  b: ['/guide/keikakusho-yomikata/', '/guide/counseling-questions/', '/guide/second-opinion/'],
  c: ['/guide/second-opinion/', '/guide/tenin-okane/'],
  d: ['/jaw-surgery/saichiryou/', '/guide/second-opinion/'],
};

function recommend(q1: Q1, q2: Q2, q3: Q3): string[] {
  const paths = [...Q2_ARTICLES[q2], ...Q3_ARTICLES[q3], ...Q1_ARTICLES[q1]];
  return Array.from(new Set(paths)).slice(0, 5);
}

function ctaLevel(q1: Q1, q2: Q2, q3: Q3): 'strong' | 'so' | 'soft' {
  const complex = q3 === 'surgery' || q2 === 'ukeguchi' || q2 === 'kaikou' || q2 === 'surihetsu';
  if (complex && q1 !== 'a') return 'strong';
  if (q1 === 'b' || q1 === 'c' || q1 === 'd') return 'so';
  if (complex) return 'strong';
  return 'soft';
}

export default function SelfCheck() {
  const [step, setStep] = useState(0);
  const [q1, setQ1] = useState<Q1 | null>(null);
  const [q2, setQ2] = useState<Q2 | null>(null);
  const [q3, setQ3] = useState<Q3 | null>(null);

  const reset = () => {
    setStep(0);
    setQ1(null);
    setQ2(null);
    setQ3(null);
  };

  const done = q1 && q2 && q3 && step === 3;
  const articles = done
    ? recommend(q1!, q2!, q3!)
        .map((p) => ARTICLES.find((a) => articlePath(a) === p))
        .filter((a): a is NonNullable<typeof a> => Boolean(a))
    : [];
  const level = done ? ctaLevel(q1!, q2!, q3!) : 'soft';

  return (
    <div className="self-check" aria-live="polite">
      {step < 3 && (
        <>
          <p className="sc-progress">質問 {step + 1} / 3</p>
          {step === 0 && (
            <fieldset className="sc-q">
              <legend>いまのあなたに、いちばん近い状況は?</legend>
              {Q1_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="sc-option"
                  onClick={() => {
                    setQ1(o.value);
                    setStep(1);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </fieldset>
          )}
          {step === 1 && (
            <fieldset className="sc-q">
              <legend>いちばん近い悩みは?</legend>
              {Q2_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="sc-option"
                  onClick={() => {
                    setQ2(o.value);
                    setStep(2);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </fieldset>
          )}
          {step === 2 && (
            <fieldset className="sc-q">
              <legend>言われたこと・気がかりで、いちばん近いものは?</legend>
              {Q3_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="sc-option"
                  onClick={() => {
                    setQ3(o.value);
                    setStep(3);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </fieldset>
          )}
        </>
      )}

      {done && (
        <div className="sc-result">
          <h2>あなたが最初に読むべき記事</h2>
          <p className="sc-note">
            ※このチェックは診断ではなく、状況に合った記事のご案内です。実際の判断には歯科医師の診察が必要です。
          </p>
          <ul className="article-list">
            {articles.map((a) => (
              <li key={a.slug}>
                <Link href={articlePath(a)}>
                  <span className="list-title">{a.title}</span>
                  <span className="badge">{CATEGORY_LABEL[a.category]}</span>
                </Link>
              </li>
            ))}
          </ul>

          {level === 'strong' && (
            <div className="sc-cta">
              <p>
                あなたの状況は、<strong>診断と治療計画の設計が結果を左右するタイプ</strong>
                の可能性があります。記事で全体像を掴んだうえで、専門医への相談をおすすめします。
              </p>
              <div className="cta-buttons">
                <Link className="cta-button" href="/consult/complex-cases/">
                  難症例のご相談について見る
                </Link>
                <Link className="cta-button secondary" href="/consult/second-opinion/">
                  オンラインセカンドオピニオン
                </Link>
              </div>
            </div>
          )}
          {level === 'so' && (
            <div className="sc-cta">
              <p>
                すでに治療の判断に向き合っている段階です。迷いがあるまま契約・継続する前に、第三者の意見を聞く選択肢があります。
              </p>
              <div className="cta-buttons">
                <Link className="cta-button" href="/consult/second-opinion/">
                  オンラインセカンドオピニオン
                </Link>
                <Link className="cta-button secondary" href="/guide/second-opinion/">
                  セカンドオピニオンの受け方を読む
                </Link>
              </div>
            </div>
          )}
          {level === 'soft' && (
            <div className="sc-cta">
              <p>
                まずは記事で全体像を掴むのがおすすめです。読んだうえで自分のケースが気になったら、いつでもご相談ください。
              </p>
            </div>
          )}

          <p>
            <button type="button" className="sc-restart" onClick={reset}>
              最初からやり直す
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
