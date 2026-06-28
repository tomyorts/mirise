import { StatusBar } from "expo-status-bar";
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

const ROOMS = [
  { id: "front", label: "受付" },
  { id: "clinic", label: "診療室" },
  { id: "surgery", label: "オペ" },
  { id: "sterilization", label: "滅菌" },
  { id: "all", label: "全体" },
];

export default function App() {
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>MIRISE WELLMEDICAL GROUP</Text>
        <Text style={styles.title}>院内音声インカム</Text>
        <Text style={styles.subtitle}>
          ネイティブアプリ版（開発中・Phase 1）{"\n"}
          まずは、あなたのiPhoneでアプリが起動することを確認しています。
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>ルーム（準備中）</Text>
          {ROOMS.map((room) => (
            <View key={room.id} style={styles.room}>
              <Text style={styles.roomText}>{room.label}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.note}>
          次のステップで、音声通話・押して話す（PTT）・ハードボタン対応を順番に追加していきます。
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#f5f7fb",
  },
  container: {
    padding: 24,
    paddingTop: 40,
  },
  brand: {
    fontSize: 13,
    letterSpacing: 1.5,
    color: "#8a8473",
    fontWeight: "600",
    marginBottom: 6,
  },
  title: {
    fontSize: 32,
    fontWeight: "800",
    color: "#1f2f58",
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: "#526070",
    marginBottom: 24,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e3e8f0",
  },
  cardLabel: {
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "#667085",
    marginBottom: 12,
  },
  room: {
    backgroundColor: "#edf1f8",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  roomText: {
    fontSize: 17,
    fontWeight: "600",
    color: "#27354f",
  },
  note: {
    marginTop: 24,
    fontSize: 14,
    lineHeight: 21,
    color: "#667085",
  },
});
