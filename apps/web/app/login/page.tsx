import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "ログイン | MIRAI LINK",
};

export default function LoginPage() {
  return <LoginForm />;
}
