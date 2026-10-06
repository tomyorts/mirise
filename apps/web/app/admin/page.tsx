import type { Metadata } from "next";
import { AdminClient } from "./AdminClient";

export const metadata: Metadata = {
  title: "管理画面 | MIRAI LINK",
};

export default function AdminPage() {
  return <AdminClient />;
}
