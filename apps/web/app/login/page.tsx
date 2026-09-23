import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "ログイン | MIRISE 院内音声インカム",
};

export default function LoginPage() {
  return <LoginForm />;
}
