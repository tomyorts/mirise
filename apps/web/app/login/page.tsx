import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "ログイン | MIRISE Intercom",
};

export default function LoginPage() {
  return <LoginForm />;
}
