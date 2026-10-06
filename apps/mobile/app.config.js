// app.json を元に、ビルドの種類(開発 / 配布)で変わる設定だけをここで上書きする。
//
// 配布ビルド(TestFlight / App Store / 社内配布)とみなす条件:
//   - EAS Build の production / preview プロファイル
//   - または APP_VARIANT=release を付けて実行した場合(Xcodeでのアーカイブ前の prebuild など)
module.exports = ({ config }) => {
  const profile = process.env.EAS_BUILD_PROFILE;
  const isRelease =
    profile === "production" || profile === "preview" || process.env.APP_VARIANT === "release";

  if (isRelease && process.env.EXPO_PUBLIC_INTERCOM_KEY) {
    // 旧方式の共通キーがアプリに埋め込まれると、院外に渡った時に誰でもサーバーを使えてしまう。
    // 配布ビルドでは医院パスワードによる端末登録を使うので、キーは設定しないこと。
    throw new Error(
      "配布ビルドに EXPO_PUBLIC_INTERCOM_KEY が設定されています。.env から削除してからビルドしてください。"
    );
  }

  return {
    ...config,
    ios: {
      ...config.ios,
      entitlements: {
        ...config.ios.entitlements,
        // プッシュ通知の送り先環境。開発ビルドは development、配布ビルドは production。
        "aps-environment": isRelease ? "production" : "development",
      },
    },
  };
};
