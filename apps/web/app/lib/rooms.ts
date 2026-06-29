export type IntercomRoom = {
  id: string;
  label: string;
  description: string;
};

export const INTERCOM_ROOMS: IntercomRoom[] = [
  { id: "front", label: "受付", description: "受付・会計・予約確認" },
  { id: "clinic", label: "診療室", description: "診療中の通常連携" },
  { id: "surgery", label: "オペ", description: "外科・オペ中の連携" },
  { id: "sterilization", label: "滅菌", description: "器具・滅菌・バックヤード" },
  { id: "all", label: "全体", description: "全体呼び出し・緊急連絡" }
];

export function getRoomLabel(roomId: string): string {
  return INTERCOM_ROOMS.find((room) => room.id === roomId)?.label ?? roomId;
}
