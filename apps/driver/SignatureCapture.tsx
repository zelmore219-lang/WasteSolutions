import React, { useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  PanResponder,
  StyleSheet,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { toByteArray } from "base64-js";
export function SignatureCapture({
  save,
  cancel,
}: {
  save: (bytes: Uint8Array, name: string) => Promise<void>;
  cancel: () => void;
}) {
  const svg = useRef<Svg | null>(null),
    current = useRef("");
  const [canvasWidth, setCanvasWidth] = useState(360);
  const [paths, setPaths] = useState<string[]>([]),
    [drawing, setDrawing] = useState(""),
    [name, setName] = useState(""),
    [consent, setConsent] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          current.current = `M ${e.nativeEvent.locationX.toFixed(1)} ${e.nativeEvent.locationY.toFixed(1)}`;
          setDrawing(current.current);
        },
        onPanResponderMove: (e) => {
          if (current.current.length > 100000) return;
          current.current += ` L ${e.nativeEvent.locationX.toFixed(1)} ${e.nativeEvent.locationY.toFixed(1)}`;
          setDrawing(current.current);
        },
        onPanResponderRelease: () => {
          if (current.current) setPaths((p) => [...p, current.current]);
          current.current = "";
          setDrawing("");
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  async function submit() {
    if (!svg.current) return;
    setBusy(true);
    setError("");
    try {
      const value = await new Promise<string>((resolve) =>
        svg.current!.toDataURL(resolve),
      );
      await save(toByteArray(value), name.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.page}>
      <Text style={s.title}>Service acknowledgment</Text>
      <Text>
        Customer acknowledgment: I acknowledge receipt of the described service.
      </Text>
      <TextInput
        style={s.input}
        placeholder="Customer signer name"
        value={name}
        onChangeText={setName}
      />
      <View
        style={s.canvas}
        onLayout={(e) => setCanvasWidth(e.nativeEvent.layout.width)}
        {...pan.panHandlers}
      >
        <Svg
          ref={svg}
          width="100%"
          height="220"
          viewBox={`0 0 ${canvasWidth} 220`}
        >
          {paths.map((d, i) => (
            <Path key={i} d={d} stroke="#17342e" strokeWidth={3} fill="none" />
          ))}
          <Path d={drawing} stroke="#17342e" strokeWidth={3} fill="none" />
        </Svg>
      </View>
      <Pressable onPress={() => setConsent(!consent)}>
        <Text>
          {consent ? "☑" : "☐"} The customer agrees to the acknowledgment above.
        </Text>
      </Pressable>
      {error && <Text style={s.error}>{error}</Text>}
      <Pressable
        style={s.button}
        disabled={busy || !name.trim() || !consent || paths.length === 0}
        onPress={() => void submit()}
      >
        <Text style={s.white}>Save signed acknowledgment</Text>
      </Pressable>
      <Pressable
        style={s.secondary}
        disabled={busy}
        onPress={() => {
          setPaths([]);
          setDrawing("");
        }}
      >
        <Text>Clear signature</Text>
      </Pressable>
      <Pressable style={s.secondary} disabled={busy} onPress={cancel}>
        <Text>Cancel</Text>
      </Pressable>
    </View>
  );
}
const s = StyleSheet.create({
  page: { padding: 24, gap: 18, backgroundColor: "#f3f6f4", flex: 1 },
  title: { fontSize: 24, fontWeight: "700", color: "#17342e" },
  input: {
    backgroundColor: "white",
    padding: 15,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#ccd7d1",
  },
  canvas: {
    backgroundColor: "white",
    height: 220,
    borderWidth: 1,
    borderColor: "#ccd7d1",
    borderRadius: 5,
  },
  button: { backgroundColor: "#186b50", padding: 15, borderRadius: 5 },
  white: { color: "white", fontWeight: "600" },
  secondary: { padding: 15, backgroundColor: "#e2eae4", borderRadius: 5 },
  error: { color: "#a13030" },
});
