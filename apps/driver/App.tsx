import { advanceRentalPickup } from "./rental-projection";
import { cacheToolAcknowledgement } from "./driver-tool-cache";
import { DriverTools } from "./DriverTools";
import {
  Action,
  pendingActions,
  queueAction,
  syncActions,
} from "./action-queue";
import * as Location from "expo-location";
import { DriverEvidence } from "./DriverEvidence";
import {
  mediaQueue,
  queueMedia,
  sendQueuedMedia,
  clearInterruptedUploads,
} from "./media-vault";
import React, { useEffect, useState, useRef } from "react";
import {
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Linking,
  View,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import { EncryptedStorage } from "./encrypted-storage";
import { initializeApp } from "firebase/app";
import {
  initializeAuth,
  getReactNativePersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  User,
} from "firebase/auth";
import { Command, synchronize, SyncFailure } from "./sync";
type Job = {
  id: string;
  customer_name: string;
  address: string;
  status: string;
  version: number;
  instructions: string;
  service_window_start?: string | null;
  service_window_end?: string | null;
  service_duration_minutes?: number;
  rental_id?: string;
  rental_action?: string;
  container_number?: string;
  replacement_container_number?: string | null;
  truck_id?: string;
  truck_status?: string;
  parent_order_id?: string;
  parent_status?: string;
  parent_order_number?: string;
  depends_on_parent?: boolean;
  number?: string;
  priority?: string;
  arrived_at?: string | null;
  tasks?: {
    id: string;
    label: string;
    required: boolean;
    version: number;
    completed_at: string | null;
  }[];
};
const base = process.env.EXPO_PUBLIC_API_URL;
const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const secureStorage = new EncryptedStorage(
  SecureStore,
  (key) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key),
  () => Crypto.randomUUID(),
);
const auth = projectId
  ? initializeAuth(
      initializeApp({
        apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
        projectId,
        authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
      }),
      { persistence: getReactNativePersistence(secureStorage) },
    )
  : null;
// Identity-scoped encrypted entries. Firebase tokens and passwords are never written to this queue.
const indexKey = (uid: string) =>
  `cw.${Array.from(uid)
    .map((c) => c.codePointAt(0)!.toString(16))
    .join("_")}.queue`;
async function keys(uid: string): Promise<string[]> {
  return JSON.parse((await secureStorage.getItem(indexKey(uid))) || "[]");
}
async function commands(uid: string): Promise<Command[]> {
  const result: Command[] = [];
  for (const k of await keys(uid)) {
    const value = await secureStorage.getItem("cw.command." + k);
    if (!value)
      throw new Error(
        "Offline queue is inconsistent; contact support before continuing",
      );
    result.push(JSON.parse(value));
  }
  return result;
}
export default function App() {
  const gps = useRef<Location.LocationSubscription | null>(null);
  const acting = useRef(false);
  const [containerChecks, setContainerChecks] = useState<
    Record<
      string,
      { container_number: string; replacement_container_number?: string }
    >
  >({});
  const [sharingLocation, setSharingLocation] = useState(false),
    [mediaCount, setMediaCount] = useState(0),
    [conflict, setConflict] = useState(false);
  const network = Network.useNetworkState();
  const previousConnection = useRef<boolean | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const [actionCount, setActionCount] = useState(0),
    [toolsRefresh, setToolsRefresh] = useState(0),
    [failureJob, setFailureJob] = useState<string | null>(null),
    [failureNote, setFailureNote] = useState("");
  const [user, setUser] = useState<User | null>(null),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [queued, setQueued] = useState(0);
  async function api(path: string, body?: unknown, key?: string) {
    if (!base || !base.startsWith("https://"))
      throw new Error("Configure an HTTPS EXPO_PUBLIC_API_URL");
    const token = await user?.getIdToken();
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await r.json();
    if (!r.ok)
      throw new SyncFailure(
        r.status,
        typeof value.message === "string"
          ? value.message
          : JSON.stringify(value.message),
      );
    return value;
  }
  async function sendMedia(data: FormData, key: string) {
    if (!base?.startsWith("https://"))
      throw Error("Configure an HTTPS API address");
    const r = await fetch(base + "/attachments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await user?.getIdToken()}`,
        "Idempotency-Key": key,
      },
      body: data,
    });
    if (!r.ok) {
      const e = await r.json();
      throw new SyncFailure(
        r.status,
        typeof e.message === "string" ? e.message : "Attachment upload failed",
      );
    }
  }
  async function toggleLocation() {
    if (gps.current) {
      gps.current.remove();
      gps.current = null;
      setSharingLocation(false);
      return;
    }
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) throw Error("Location permission was not granted");
    gps.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 30000,
        distanceInterval: 50,
      },
      (position) => {
        void api(
          "/drivers/location",
          {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy_m: position.coords.accuracy ?? 100,
            recorded_at: new Date(position.timestamp).toISOString(),
            consent: true,
          },
          Crypto.randomUUID(),
        ).catch(() =>
          setError(
            "Location sharing is unavailable while offline. Service work remains saved.",
          ),
        );
      },
    );
    setSharingLocation(true);
  }
  useEffect(() => {
    try {
      clearInterruptedUploads();
    } catch {
      /* Private cache cleanup is retried on next launch. */
    }
    return () => {
      gps.current?.remove();
    };
  }, []);
  async function act(fn: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof SyncFailure && e.status === 409) setConflict(true);
      setError((e as Error).message);
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }
  function overlay(remote: Job[], pending: Command[]) {
    for (const command of pending) {
      const job = remote.find((j) => j.id === command.orderId);
      if (job && job.version === command.body.version) {
        if (command.body.status === "arrived")
          job.arrived_at = command.performed_at;
        else job.status = command.body.status;
        job.version++;
        if (command.body.status === "completed")
          remote = advanceRentalPickup(remote, job);
      }
    }
    return remote;
  }
  function overlayTasks(
    remote: Job[],
    pending: Awaited<ReturnType<typeof pendingActions>>,
  ) {
    for (const action of pending)
      if (action.kind === "task") {
        const job = remote.find((j) => j.id === action.orderId),
          task = job?.tasks?.find((t) => t.id === action.taskId);
        if (task && task.version === action.body.version) {
          task.completed_at = action.body.performed_at;
          task.version++;
        }
      }
    return remote;
  }
  async function sendAction(path: string, body: unknown, key: string) {
    const result = await api(path, body, key);
    await cacheToolAcknowledgement(secureStorage, user!.uid, path, result);
    if (
      path.startsWith("/disposal-loads/") ||
      (path.startsWith("/rentals/") && path.endsWith("/disposal"))
    ) {
      const cache = "jobs:" + user!.uid;
      const saved: any[] = JSON.parse(
        (await secureStorage.getItem(cache)) || "[]",
      );
      const disposal = path.startsWith("/rentals/");
      await secureStorage.setItem(
        cache,
        JSON.stringify(
          saved.map((j) =>
            j.id === result.order_id
              ? {
                  ...j,
                  ...(disposal
                    ? { disposal_ticket_id: result.id }
                    : {
                        disposal_load_id: result.id,
                        disposal_driver_id: result.assigned_driver_id,
                      }),
                }
              : j,
          ),
        ),
      );
    }
    if (path.includes("/tasks/")) {
      const cache = "jobs:" + user!.uid;
      const saved: Job[] = JSON.parse(
        (await secureStorage.getItem(cache)) || "[]",
      );
      await secureStorage.setItem(
        cache,
        JSON.stringify(
          saved.map((j) =>
            j.id === result.order_id
              ? {
                  ...j,
                  tasks: j.tasks?.map((t) =>
                    t.id === result.id ? { ...t, ...result } : t,
                  ),
                }
              : j,
          ),
        ),
      );
    }
    return result;
  }
  async function restore() {
    const stored = await secureStorage.getItem("profile:" + user!.uid);
    if (!stored) return false;
    const profile = JSON.parse(stored);
    if (
      profile.role !== "driver" ||
      Date.now() - profile.checkedAt > 24 * 60 * 60 * 1000
    )
      return false;
    const value = await secureStorage.getItem("jobs:" + user!.uid);
    if (!value) return false;
    const pending = await commands(user!.uid);
    setJobs(
      overlayTasks(
        overlay(JSON.parse(value), pending),
        await pendingActions(secureStorage, user!.uid),
      ),
    );
    setQueued(pending.length);
    setActionCount((await pendingActions(secureStorage, user!.uid)).length);
    setMediaCount((await mediaQueue(secureStorage, user!.uid)).length);
    setOffline(true);
    return true;
  }
  async function refresh() {
    const me = await api("/me");
    if (me.role !== "driver")
      throw new Error("A provisioned driver account is required");
    const remote: Job[] = await api("/orders?sort=priority");
    const company = await api("/company");
    const pending = await commands(user!.uid);
    await secureStorage.setItem(
      "profile:" + user!.uid,
      JSON.stringify({
        role: "driver",
        checkedAt: Date.now(),
        timezone: company.timezone,
      }),
    );
    await secureStorage.setItem("jobs:" + user!.uid, JSON.stringify(remote));
    setJobs(
      overlayTasks(
        overlay(remote, pending),
        await pendingActions(secureStorage, user!.uid),
      ),
    );
    setQueued(pending.length);
    setActionCount((await pendingActions(secureStorage, user!.uid)).length);
    setMediaCount((await mediaQueue(secureStorage, user!.uid)).length);
    setOffline(false);
  }
  useEffect(() => (auth ? onAuthStateChanged(auth, setUser) : undefined), []);
  useEffect(() => {
    setJobs([]);
    setContainerChecks({});
    setQueued(0);
    setOffline(false);
    if (user)
      void act(async () => {
        const restored = await restore();
        try {
          await refresh();
        } catch (e) {
          if (!restored) throw e;
          setError(
            "Offline: showing encrypted saved work. Synchronize when service returns.",
          );
        }
      });
  }, [user]);
  useEffect(() => {
    const connected =
      network.isConnected === true && network.isInternetReachable !== false;
    const previous = previousConnection.current;
    previousConnection.current = connected;
    if (user && connected && previous === false && !busy) void act(sync);
  }, [network.isConnected, network.isInternetReachable]);
  useEffect(() => {
    if (!user || network.isConnected !== true || offline || busy) return;
    const timer = setInterval(() => void act(refresh), 30000);
    return () => clearInterval(timer);
  }, [user?.uid, network.isConnected, offline, busy]);
  useEffect(
    () => () => {
      gps.current?.remove();
      gps.current = null;
    },
    [user?.uid],
  );
  async function enqueue(
    job: Job,
    status: "in_progress" | "arrived" | "completed" | "failed",
    note = "",
  ) {
    const profile = JSON.parse(
      (await secureStorage.getItem("profile:" + user!.uid)) || "null",
    );
    if (!profile || Date.now() - profile.checkedAt > 24 * 60 * 60 * 1000)
      throw new Error(
        "Reconnect to verify your account before recording more offline work",
      );
    if (
      status === "completed" &&
      job.tasks?.some((t) => t.required && !t.completed_at)
    )
      throw Error("Complete required tasks before completing service");
    if (status === "in_progress") {
      if (
        job.depends_on_parent &&
        !["completed", "invoiced"].includes(
          jobs.find((j) => j.id === job.parent_order_id)?.status ||
            job.parent_status ||
            "",
        )
      )
        throw Error(
          "Complete the parent service before starting this dependent order.",
        );
      const safety = await pendingActions(secureStorage, user!.uid);
      if (
        (job.truck_status && job.truck_status !== "available") ||
        safety.some(
          (a) =>
            a.kind === "inspection" &&
            a.body.truck_id === job.truck_id &&
            !a.body.safe_to_operate,
        )
      )
        throw Error(
          "This truck is unavailable or has a reported safety defect. Contact dispatch before starting work.",
        );
    }
    let verification: Command["body"]["container_verification"];
    if (status === "completed" && job.rental_action) {
      const typed = containerChecks[job.id];
      if (
        !typed ||
        typed.container_number.trim() !== job.container_number ||
        (job.replacement_container_number &&
          typed.replacement_container_number?.trim() !==
            job.replacement_container_number)
      )
        throw Error(
          "Check and enter the actual assigned container number and any exchange replacement before completing this job. Contact dispatch about any mismatch.",
        );
      verification = {
        container_number: typed.container_number.trim(),
        ...(job.replacement_container_number
          ? {
              replacement_container_number:
                typed.replacement_container_number!.trim(),
            }
          : {}),
      };
    }
    const existing = await keys(user!.uid);
    if (existing.length >= 40)
      throw new Error("Synchronize pending work before recording more jobs");
    // Key generated before durable write and reused on every retry. No automatic conflict overwrite.
    const key = Crypto.randomUUID();
    const performedAt = new Date().toISOString();
    const command: Command = {
      key,
      orderId: job.id,
      performed_at: performedAt,
      body: {
        status,
        ...(verification ? { container_verification: verification } : {}),
        performed_at: performedAt,
        version: job.version,
        note,
        service_date: new Intl.DateTimeFormat("en-CA", {
          timeZone: profile.timezone || "America/Chicago",
        }).format(new Date()),
      },
    };
    await secureStorage.setItem("cw.command." + key, JSON.stringify(command));
    await secureStorage.setItem(
      indexKey(user!.uid),
      JSON.stringify([...existing, key]),
    );
    if (status !== "arrived")
      setContainerChecks((old) => {
        const next = { ...old };
        delete next[job.id];
        return next;
      });
    const nextJobs = jobs.map((j) =>
      j.id === job.id
        ? {
            ...j,
            status: status === "arrived" ? j.status : status,
            arrived_at: status === "arrived" ? performedAt : j.arrived_at,
            version: j.version + 1,
          }
        : j,
    );
    setJobs(
      status === "completed" ? advanceRentalPickup(nextJobs, job) : nextJobs,
    );
    setQueued(existing.length + 1);
  }
  async function sync() {
    setConflict(false);
    await syncActions(
      secureStorage,
      user!.uid,
      sendAction,
      (a) => a.kind === "task" || a.kind === "inspection",
    );
    await synchronize(
      {
        list: () => commands(user!.uid),
        remove: async (key) => {
          const remaining = (await keys(user!.uid)).filter((k) => k !== key);
          await secureStorage.setItem(
            indexKey(user!.uid),
            JSON.stringify(remaining),
          );
          await secureStorage.removeItem("cw.command." + key);
          setQueued(remaining.length);
        },
      },
      async (c) => {
        const result = await api(`/orders/${c.orderId}/status`, c.body, c.key);
        const cached: Job[] = JSON.parse(
          (await secureStorage.getItem("jobs:" + user!.uid)) || "[]",
        );
        const updated = cached.map((j) =>
          j.id === result.id ? { ...j, ...result } : j,
        );
        const completed = updated.find((j) => j.id === result.id);
        await secureStorage.setItem(
          "jobs:" + user!.uid,
          JSON.stringify(
            c.body.status === "completed" && completed
              ? advanceRentalPickup(updated, completed)
              : updated,
          ),
        );
      },
    );
    await syncActions(secureStorage, user!.uid, sendAction);
    setActionCount((await pendingActions(secureStorage, user!.uid)).length);
    setToolsRefresh((n) => n + 1);
    await sendQueuedMedia(secureStorage, user!.uid, sendMedia);
    setMediaCount((await mediaQueue(secureStorage, user!.uid)).length);
    await refresh();
  }
  async function enqueueTool(action: Action) {
    const profile = JSON.parse(
      (await secureStorage.getItem("profile:" + user!.uid)) || "null",
    );
    if (!profile || Date.now() - profile.checkedAt > 86400000)
      throw Error(
        "Reconnect to verify your account before saving more offline updates",
      );
    await queueAction(secureStorage, user!.uid, action, Crypto.randomUUID());
    if (action.kind === "task")
      setJobs((current) =>
        current.map((j) =>
          j.id === action.orderId
            ? {
                ...j,
                tasks: j.tasks?.map((t) =>
                  t.id === action.taskId
                    ? {
                        ...t,
                        completed_at: action.body.performed_at,
                        version: t.version + 1,
                      }
                    : t,
                ),
              }
            : j,
        ),
      );
    setActionCount((await pendingActions(secureStorage, user!.uid)).length);
  }
  async function submitConflicts() {
    for (const c of await commands(user!.uid)) {
      await api(
        "/sync/exceptions",
        {
          order_id: c.orderId,
          command_key: c.key,
          original_version: c.body.version,
          original_body: c.body,
          reported_status: c.body.status,
          note:
            c.body.note ||
            "Offline update conflicted with dispatch. Review service evidence before billing.",
          performed_at: c.performed_at || new Date().toISOString(),
        },
        c.key + "_review",
      );
      const remaining = (await keys(user!.uid)).filter((k) => k !== c.key);
      await secureStorage.setItem(
        indexKey(user!.uid),
        JSON.stringify(remaining),
      );
      await secureStorage.removeItem("cw.command." + c.key);
    }
    setConflict(false);
    await refresh();
  }
  if (!user)
    return (
      <SafeAreaView style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.brand}>COREWASTE / DRIVER</Text>
          <Text style={s.title}>Ready for the route.</Text>
          <Text>
            Sign in to load your assigned work. Saved work and pending status
            changes are encrypted on this device for offline use.
          </Text>
          {!auth && (
            <Text style={s.error}>Firebase configuration is required.</Text>
          )}
          <TextInput
            style={s.input}
            placeholder="Work email"
            autoCapitalize="none"
            autoComplete="email"
            value={email}
            onChangeText={setEmail}
          />
          <TextInput
            style={s.input}
            placeholder="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
          <Pressable
            disabled={busy || !auth}
            style={s.button}
            onPress={() =>
              void act(async () => {
                const r = await signInWithEmailAndPassword(
                  auth!,
                  email,
                  password,
                );
                setPassword("");
                setUser(r.user);
              })
            }
          >
            <Text style={s.white}>Sign in</Text>
          </Pressable>
          {error && <Text style={s.error}>{error}</Text>}
        </ScrollView>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={s.page}>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.brand}>COREWASTE / DRIVER</Text>
        <Text style={s.title}>Your service work</Text>
        <Text>
          {offline
            ? "Offline · encrypted saved work"
            : "Connected service work"}
        </Text>
        <Text>
          {queued} encrypted status updates and {mediaCount} media files waiting
          to sync · {actionCount} messages, inspections or disposal updates
        </Text>
        {conflict && (
          <Pressable
            disabled={busy}
            style={s.button}
            onPress={() => void act(submitConflicts)}
          >
            <Text style={s.white}>
              Send pending conflict evidence to dispatch
            </Text>
          </Pressable>
        )}
        <Pressable
          disabled={busy}
          style={s.button}
          onPress={() => void act(toggleLocation)}
        >
          <Text style={s.white}>
            {sharingLocation
              ? "Stop sharing location"
              : "Share location while on duty"}
          </Text>
        </Pressable>
        <Text>
          Location sharing is optional and runs while this app is in use. It
          stops when you sign out.
        </Text>
        {error && (
          <Text accessibilityRole="alert" style={s.error}>
            {error} — Pending updates are retained. For conflicts, contact
            dispatch; do not repeat service.
          </Text>
        )}
        <View style={s.row}>
          <Pressable
            disabled={busy}
            style={s.button}
            onPress={() => void act(sync)}
          >
            <Text style={s.white}>Synchronize</Text>
          </Pressable>
          <Pressable
            disabled={busy}
            style={s.button}
            onPress={() => void act(refresh)}
          >
            <Text style={s.white}>Refresh work</Text>
          </Pressable>
        </View>
        <DriverTools
          uid={user.uid}
          jobs={jobs}
          store={secureStorage}
          api={api}
          enqueue={enqueueTool}
          refresh={toolsRefresh}
          connected={!offline && network.isConnected === true}
          onQueueChange={async () =>
            setActionCount(
              (await pendingActions(secureStorage, user.uid)).length,
            )
          }
        />
        {jobs.length === 0 && <Text>No assigned jobs.</Text>}
        {jobs.map((j) => (
          <View key={j.id} style={s.card}>
            <Text style={s.status}>{j.status.replace("_", " ")}</Text>
            <Text style={s.job}>{j.customer_name}</Text>
            <Text>
              {"CW-O" + String(j.number || "").padStart(6, "0")} ·{" "}
              {j.priority || "normal"} priority
            </Text>
            {j.depends_on_parent && (
              <Text>
                Parent service{" "}
                {"CW-O" + String(j.parent_order_number || "").padStart(6, "0")}{" "}
                must be complete before starting.
              </Text>
            )}
            <Text>{j.address}</Text>
            <Text>{j.instructions}</Text>
            {(j.service_window_start ||
              Boolean(j.service_duration_minutes)) && (
              <Text>
                Arrival window:{" "}
                {j.service_window_start
                  ? j.service_window_start.slice(0, 5) +
                    "–" +
                    j.service_window_end?.slice(0, 5)
                  : "not specified"}{" "}
                (company time) · Planned service{" "}
                {j.service_duration_minutes || 0} minutes
              </Text>
            )}
            {j.tasks?.map((t) => (
              <View key={t.id}>
                <Text>
                  {t.completed_at ? "✓" : "○"} {t.label}
                  {t.required ? " (required)" : ""}
                </Text>
                {!t.completed_at &&
                  ["assigned", "in_progress"].includes(j.status) && (
                    <Pressable
                      disabled={busy}
                      style={s.button}
                      onPress={() =>
                        void act(() =>
                          enqueueTool({
                            kind: "task",
                            orderId: j.id,
                            taskId: t.id,
                            body: {
                              version: t.version,
                              note: "",
                              performed_at: new Date().toISOString(),
                            },
                          }),
                        )
                      }
                    >
                      <Text style={s.white}>Complete task</Text>
                    </Pressable>
                  )}
              </View>
            ))}
            {j.arrived_at && (
              <Text>
                Arrival recorded: {new Date(j.arrived_at).toLocaleString()}
              </Text>
            )}
            {j.status === "in_progress" && !j.arrived_at && (
              <Pressable
                disabled={busy}
                style={s.button}
                onPress={() => void act(() => enqueue(j, "arrived"))}
              >
                <Text style={s.white}>Record arrival</Text>
              </Pressable>
            )}
            {j.status === "in_progress" && j.rental_action && (
              <View>
                <Text style={s.title}>Physical container confirmation</Text>
                <Text>
                  Read the number on the actual equipment. Assigned{" "}
                  {j.container_number}
                  {j.replacement_container_number
                    ? "; replacement " + j.replacement_container_number
                    : ""}
                  . Contact dispatch about any mismatch.
                </Text>
                <TextInput
                  style={s.input}
                  accessibilityLabel="Physically verified container number"
                  placeholder="Actual container number"
                  maxLength={80}
                  value={containerChecks[j.id]?.container_number || ""}
                  onChangeText={(value) =>
                    setContainerChecks((old) => ({
                      ...old,
                      [j.id]: { ...old[j.id], container_number: value },
                    }))
                  }
                />
                {j.replacement_container_number && (
                  <TextInput
                    style={s.input}
                    accessibilityLabel="Physically verified replacement number"
                    placeholder="Actual replacement number"
                    maxLength={80}
                    value={
                      containerChecks[j.id]?.replacement_container_number || ""
                    }
                    onChangeText={(value) =>
                      setContainerChecks((old) => ({
                        ...old,
                        [j.id]: {
                          ...old[j.id],
                          container_number: old[j.id]?.container_number || "",
                          replacement_container_number: value,
                        },
                      }))
                    }
                  />
                )}
              </View>
            )}
            {["assigned", "in_progress"].includes(j.status) && (
              <>
                <Pressable
                  disabled={busy}
                  style={s.button}
                  onPress={() => {
                    setFailureJob(j.id);
                    setFailureNote("");
                  }}
                >
                  <Text style={s.white}>
                    Report failed pickup / unable to dump
                  </Text>
                </Pressable>
                {failureJob === j.id && (
                  <>
                    <TextInput
                      accessibilityLabel="Reason service could not be completed"
                      multiline
                      style={s.input}
                      placeholder="Explain the service problem"
                      maxLength={2000}
                      value={failureNote}
                      onChangeText={setFailureNote}
                    />
                    <Pressable
                      style={s.button}
                      disabled={busy || !failureNote.trim()}
                      onPress={() =>
                        void act(async () => {
                          await enqueue(j, "failed", failureNote.trim());
                          setFailureJob(null);
                          setFailureNote("");
                        })
                      }
                    >
                      <Text style={s.white}>Save failed service report</Text>
                    </Pressable>
                  </>
                )}
              </>
            )}
            <DriverEvidence
              capture={async (kind, bytes, name) => {
                const profile = JSON.parse(
                  (await secureStorage.getItem("profile:" + user.uid)) ||
                    "null",
                );
                if (!profile || Date.now() - profile.checkedAt > 86400000)
                  throw Error(
                    "Reconnect to verify your account before recording evidence",
                  );
                await queueMedia(
                  secureStorage,
                  user.uid,
                  j.id,
                  kind,
                  bytes,
                  name,
                );
                setMediaCount(
                  (await mediaQueue(secureStorage, user.uid)).length,
                );
              }}
            />
            <Pressable
              style={s.button}
              onPress={() =>
                void Linking.openURL(
                  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(j.address)}`,
                )
              }
            >
              <Text style={s.white}>Open navigation</Text>
            </Pressable>
            {["assigned", "in_progress"].includes(j.status) && (
              <Pressable
                style={s.button}
                disabled={busy}
                onPress={() =>
                  void act(() =>
                    enqueue(
                      j,
                      j.status === "assigned" ? "in_progress" : "completed",
                    ),
                  )
                }
              >
                <Text style={s.white}>
                  {j.status === "assigned"
                    ? "Record service start"
                    : "Record service completion"}
                </Text>
              </Pressable>
            )}
          </View>
        ))}
        <Pressable
          style={s.button}
          disabled={busy}
          onPress={() =>
            void act(async () => {
              gps.current?.remove();
              gps.current = null;
              setSharingLocation(false);
              await signOut(auth!);
              setUser(null);
              setJobs([]);
              setQueued(0);
            })
          }
        >
          <Text style={s.white}>Sign out (pending work stays encrypted)</Text>
        </Pressable>
        <Text>
          Offline status changes are retained across restarts. Reconnect at
          least once every 24 hours to verify account access. Conflicting
          updates remain queued for dispatch review.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f3f6f4" },
  content: { padding: 24, gap: 18 },
  brand: { color: "#186b50", fontWeight: "800", letterSpacing: 2 },
  title: { fontSize: 28, fontWeight: "700", color: "#17342e" },
  input: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#ccd7d1",
    padding: 15,
    borderRadius: 5,
  },
  button: {
    backgroundColor: "#186b50",
    padding: 14,
    borderRadius: 5,
    marginTop: 8,
  },
  white: { color: "white", fontWeight: "600" },
  error: { color: "#9c3333", padding: 12, backgroundColor: "#fde9e8" },
  card: { backgroundColor: "white", padding: 20, borderRadius: 8, gap: 10 },
  job: { fontSize: 20, fontWeight: "600" },
  status: { textTransform: "uppercase", fontSize: 12, color: "#186b50" },
  row: { flexDirection: "row", gap: 12 },
});
