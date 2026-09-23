import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="not-found container">
      <h1>お探しのページは見つかりませんでした</h1>
      <p>URLが変更されたか、削除された可能性があります。</p>
      <p>
        <Link href="/">トップページへ戻る</Link>
      </p>
    </div>
  );
}
