/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  // 既存クリニックサイト(WordPress, mirise-ortho.com)のサブディレクトリ /media/ 配下で配信する。
  // basePathにより<Link>・静的アセットのURLは自動で /media が付く(生の<a>は付かないため<Link>に統一済み)。
  basePath: '/media',
};

export default nextConfig;
