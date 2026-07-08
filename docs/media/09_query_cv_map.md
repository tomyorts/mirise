# 09. クエリ→記事→CVマップ

PV(検索流入)とCV(相談転換)を接続する設計図。全25記事を「読者の意思決定段階」に配置し、各記事の狙いクエリ・CTA・内部リンクを定義する。

## 1. CVファネル設計

```
[認知]  症状・悩みで検索 ────────→ FAQ記事・症状記事(受け口/開咬/非対称/顔の変化…)
   │                                    │ 内部リンク: 症状→診断→制度
   ▼                                    ▼
[比較検討] 治療法・費用・制度を調べる → 柱記事(保険適用/SF/外科の流れ/費用の仕組み…)
   │                                    │ ツール: 3分セルフチェック(/check/)
   ▼                                    ▼
[行動]  誰に相談するか決める ────────→ ガイド記事(SO受け方/15の質問/計画書の読み方)
                                        │
                                        ▼
                              CV: 難症例相談 / オンラインSO / (LINE登録=中間CV)
```

- **認知段の役割**: PVの最大化と「このサイトは信用できる」の初回体験。CTAは踏ませない(固定フッターのみ)
- **比較検討段の役割**: AI Overview引用の獲得(定義→条件→数字の構造)と、セルフチェックへの誘導
- **行動段の役割**: 相談の質を上げる(準備した患者は成約率・満足度が高い)。CVボタンはここで初めて意味を持つ

## 2. 記事別クエリマップ(全25本)

### 難症例・外科矯正(12本)— PVとCVの主戦場

| パス | 主要クエリ | 検索意図/読者の状態 | 主CTA |
|---|---|---|---|
| /jaw-surgery/hoken-tekiyo/ | 顎変形症 保険適用 条件 | 費用不安。制度が複雑で答えを探している | 難症例相談 |
| /jaw-surgery/surgery-first/ | サージェリーファースト デメリット | 手術提案済み。期間短縮に期待+不安 | 難症例相談 |
| /jaw-surgery/geka-nagare/ | 外科矯正 流れ 入院期間 仕事復帰 | 手術を現実的に検討。生活影響を知りたい | 難症例相談 |
| /jaw-surgery/geka-risk/ | 顎 手術 麻痺 / 外科矯正 後戻り | リスクを直視したい(最も信頼を生む記事) | SO |
| /jaw-surgery/geka-shokuji/ | 顎 手術後 食事 / 顎間固定 食事 | 術前患者・家族。競合が薄い高需要クエリ | 難症例相談 |
| /jaw-surgery/ukeguchi-shindan/ | 受け口 矯正だけ 手術しない | 手術回避願望。骨格性/歯性の診断へ誘導 | 難症例相談 |
| /jaw-surgery/gakuhenkei-mouthpiece/ | 顎変形症 インビザライン できない | 他院で断られ理由が分からない | 難症例相談 |
| /jaw-surgery/ganmen-hitaishou/ | 顔 左右非対称 治したい | 美容系情報に埋もれた医療需要の受け皿 | 難症例相談 |
| /jaw-surgery/kaikou/ | 開咬 治し方 前歯 閉じない | 原因が分からない。原因3分類で構造化 | 難症例相談 |
| /jaw-surgery/saichiryou/ | 矯正 やり直し 失敗 | 前医への不信。感情に配慮した導線 | SO |
| /jaw-surgery/kougou-saiken/ | 咬合再建 噛み合わせ 全体 | 中高年・複合問題。単価の高い相談層 | 難症例相談 |
| /faq/mouthpiece-ukeguchi/ | マウスピース 受け口 治る | 認知段。診断の重要性に気づかせる | 記事回遊 |

### 意思決定ガイド(7本)— 行動段=CV直前の読者

| パス | 主要クエリ | 検索意図/読者の状態 | 主CTA |
|---|---|---|---|
| /guide/second-opinion/ | 矯正 セカンドオピニオン 失礼 | 迷いの言語化済み。CV最至近 | SO |
| /guide/counseling-questions/ | 矯正 カウンセリング 質問 | 初診前。チェックリストDL(中間CV) | LINE/DL |
| /guide/10-questions/ | 矯正 迷ってる 始めるべきか | 検討初期。自己整理ツール | 記事回遊 |
| /guide/hiyou-shikumi/ | 矯正 費用 仕組み 追加料金 | 契約前の費用不安 | 記事回遊 |
| /guide/tenin-okane/ | 矯正 転院 返金 | 治療中のトラブル。SO需要が潜在 | SO |
| /guide/dentist-erabikata/ | 矯正歯科 選び方 認定医 | 比較検討段。診断力という判断軸を提供 | SO |
| /guide/keikakusho-yomikata/ | 矯正 治療計画書 契約前 | 契約直前。最後の確認 | SO |

### 治療法(3本)+ FAQ(3本)— 認知段の入口

| パス | 主要クエリ | 主CTA |
|---|---|---|
| /treatment/wire-aligner/ | ワイヤー マウスピース どっち | 記事回遊→セルフチェック |
| /treatment/3d-simulation/ | 矯正 シミュレーション 違う | 記事回遊 |
| /treatment/basshi-hibassi/ | 矯正 抜歯 基準 | SO(抜歯セカンドオピニオン需要) |
| /faq/hibassi-genkai/ | 非抜歯矯正 デメリット | /treatment/basshi-hibassi/ へ |
| /faq/otona-nenrei/ | 矯正 年齢 上限 50代 | 記事回遊 |
| /faq/kao-kawaru/ | 矯正 顔 変わる | 記事回遊 |

## 3. 内部リンクハブ構造

```
ハブ1: /jaw-surgery/hoken-tekiyo/(保険適用)
  ← geka-nagare, ukeguchi-shindan, gakuhenkei-mouthpiece, kaikou, ganmen-hitaishou, hiyou-shikumi
  → 難症例相談

ハブ2: /guide/second-opinion/(SOの受け方)
  ← saichiryou, tenin-okane, keikakusho-yomikata, basshi-hibassi, geka-risk
  → オンラインSO

ハブ3: /check/(セルフチェック)
  ← トップページバナー, 全記事フッター
  → 状況別に記事5本+相談導線を出し分け
```

設計原則: **認知段の記事は必ず比較検討段の記事へ、比較検討段は行動段へリンクする**(逆流リンクは張らない)。CTAボタンは行動段の文脈でのみ意味を持つため、認知段記事では固定フッターに任せる。

## 4. セルフチェック(/check/)のCV設計

| 入力 | 判定 | 出し分け |
|---|---|---|
| Q1 状況(未受診/計画提示済/治療中/治療済) | 検討段階 | 計画提示済・治療中・治療済 → SO提示 |
| Q2 悩み(受け口・非対称/開咬/でこぼこ/すり減り) | 難症例シグナル | 受け口・開咬・すり減り → 難症例相談を優先提示 |
| Q3 気がかり(手術/抜歯/費用/なし) | 記事選定 | 手術 → 外科3記事、費用 → 制度2記事… |

計測ポイント(GA4実装時): check_start / check_complete(q1,q2,q3をパラメータ送信)/ check_to_article / check_to_consult。**「どの回答組合せがCVするか」が蓄積されると、記事企画とカウンセリング設計の一次データになる**(docs/media/08のKPIツリーに接続)。

## 5. 優先度と公開順

| 優先 | 記事群 | 理由 |
|---|---|---|
| 第1波(監修最優先) | hoken-tekiyo, geka-nagare, geka-shokuji, second-opinion | 需要大×競合薄×CV直結。監修が済み次第 noindex解除と同時に公開 |
| 第2波 | ukeguchi-shindan, geka-risk, saichiryou, counseling-questions, keikakusho-yomikata | 難症例CVの中核+行動段の受け皿 |
| 第3波 | 残りのFAQ・treatment・guide | 回遊網の完成。第1〜2波の引用元として機能 |

運用: 月次でSearch Consoleのクエリと照合し、想定外クエリで流入した記事は「まとめFAQ」に該当質問を追記する(docs/media/06 FAQマイニング)。
