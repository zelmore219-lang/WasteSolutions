import React, { useState } from "react";
import { Modal, SafeAreaView, Pressable, Text } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { File, Paths } from "expo-file-system";
import { SignatureCapture } from "./SignatureCapture";
export function DriverEvidence({
  capture,
}: {
  capture: (
    kind: "photo" | "signature",
    bytes: Uint8Array,
    name?: string,
  ) => Promise<void>;
}) {
  const [signature, setSignature] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function photo() {
    setBusy(true);
    setError("");
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted)
        throw Error("Camera permission is required to document service");
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.8,
        exif: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0],
        resize =
          asset.width >= asset.height
            ? { width: Math.min(asset.width, 3840) }
            : { height: Math.min(asset.height, 3840) },
        normalized = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize }],
          { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
        );
      await capture("photo", await new File(normalized.uri).bytes());
      for (const uri of [normalized.uri, asset.uri])
        if (uri.startsWith(Paths.cache.uri)) {
          const source = new File(uri);
          if (source.exists) source.delete();
        }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && <Text style={{ color: "#a13030" }}>{error}</Text>}
      <Pressable
        disabled={busy}
        onPress={() => void photo()}
        style={{ padding: 13, backgroundColor: "#e1ece5", borderRadius: 5 }}
      >
        <Text>Take service photograph</Text>
      </Pressable>
      <Pressable
        disabled={busy}
        onPress={() => setSignature(true)}
        style={{ padding: 13, backgroundColor: "#e1ece5", borderRadius: 5 }}
      >
        <Text>Capture customer signature</Text>
      </Pressable>
      <Modal
        visible={signature}
        animationType="slide"
        onRequestClose={() => setSignature(false)}
      >
        {signature && (
          <SafeAreaView style={{ flex: 1 }}>
            <SignatureCapture
              cancel={() => setSignature(false)}
              save={async (bytes, name) => {
                await capture("signature", bytes, name);
                setSignature(false);
              }}
            />
          </SafeAreaView>
        )}
      </Modal>
    </>
  );
}
