import { cacheToolSnapshot } from "./driver-tool-cache";
import { disposalWork } from "./disposal-work";
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Linking,
} from "react-native";
import {
  Action,
  ActionStorage,
  pendingActions,
  submitActionReview,
  PendingAction,
} from "./action-queue";
type Props = {
  uid: string;
  jobs: any[];
  store: ActionStorage;
  api: (path: string, body?: unknown, key?: string) => Promise<any>;
  enqueue: (action: Action) => Promise<void>;
  refresh: number;
  connected: boolean;
  onQueueChange: () => Promise<void>;
};
export function DriverTools({
  uid,
  jobs,
  store,
  api,
  enqueue,
  refresh,
  connected,
  onQueueChange,
}: Props) {
  const [actions, setActions] = useState<PendingAction[]>([]);
  const [data, setData] = useState<any>({
      messages: [],
      contacts: [],
      inspections: [],
      loads: [],
      tasks: [],
      routes: [],
    }),
    [panel, setPanel] = useState("Messages"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [info, setInfo] = useState("");
  const [recipient, setRecipient] = useState(""),
    [message, setMessage] = useState(""),
    [truck, setTruck] = useState(""),
    [kind, setKind] = useState<"pre_trip" | "post_trip">("pre_trip"),
    [odometer, setOdometer] = useState(""),
    [safe, setSafe] = useState(true),
    [notes, setNotes] = useState("");
  const [disposalJob, setDisposalJob] = useState(""),
    [facility, setFacility] = useState(""),
    [ticket, setTicket] = useState(""),
    [gross, setGross] = useState(""),
    [tare, setTare] = useState(""),
    [cost, setCost] = useState(""),
    [taskFailure, setTaskFailure] = useState(""),
    [taskFailureId, setTaskFailureId] = useState(""),
    [dumpReason, setDumpReason] = useState(""),
    [returnLater, setReturnLater] = useState(true);
  const cache = "driver-tools:" + uid;
  async function load() {
    const me = await api("/me");
    const next = {
      actor_id: me.id,
      messages: await api("/messages"),
      contacts: await api("/messages/contacts"),
      inspections: await api("/fleet/inspections"),
      loads: await api("/disposal-loads"),
      tasks: await api("/driver-tasks"),
      routes: await api("/routes"),
    };
    const merged = await cacheToolSnapshot(store, uid, next);
    setData(merged);
    setActions(await pendingActions(store, uid));
  }
  useEffect(() => {
    let cancelled = false;
    void store
      .getItem(cache)
      .then(async (value) => {
        if (value && !cancelled) {
          setData(JSON.parse(value));
          setActions(await pendingActions(store, uid));
        }
      })
      .catch(() => {});
    if (connected) void load().catch((e) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [uid, refresh, connected]);
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => void load().catch(() => {}), 30000);
    return () => clearInterval(timer);
  }, [uid, connected]);
  async function save(action: Action) {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      if (
        action.kind === "driver_task" &&
        action.body.status === "in_progress"
      ) {
        const task = (data.tasks || []).find(
          (t: any) => t.id === action.taskId,
        );
        if (
          task &&
          ((task.truck_status && task.truck_status !== "available") ||
            actions.some(
              (a) =>
                a.kind === "inspection" &&
                a.body.truck_id === task?.truck_id &&
                !a.body.safe_to_operate,
            ))
        )
          throw Error(
            "This task truck is unavailable or has a reported safety defect. Contact dispatch before starting.",
          );
      }
      await enqueue(action);
      setInfo("Saved securely. Synchronize to send this update.");
      if (action.kind === "message") setMessage("");
      if (action.kind === "inspection") setNotes("");
      setActions(await pendingActions(store, uid));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const trucks = Array.from(
    new Map(
      [
        ...jobs,
        ...(data.tasks || []),
        ...(data.loads || []).map((l: any) => ({
          truck_id: l.assigned_truck_id,
          truck_number: l.truck_number,
        })),
      ]
        .filter((j) => j.truck_id)
        .map((j) => [j.truck_id, { id: j.truck_id, number: j.truck_number }]),
    ).values(),
  );
  const pickups = disposalWork(jobs, data.loads || [], actions);
  const independentTasks = (data.tasks || []).map((t: any) => {
    let task = { ...t };
    for (const action of actions)
      if (
        action.kind === "driver_task" &&
        action.taskId === task.id &&
        action.body.version === task.version
      )
        task = {
          ...task,
          status: action.body.status,
          completion_note: action.body.note,
          version: task.version + 1,
        };
    return task;
  });
  const selected = pickups.find((j) => j.id === disposalJob);
  return (
    <View style={s.card}>
      <Text style={s.title}>Driver tools</Text>
      <View style={s.row}>
        {[
          "Routes",
          "Messages",
          "Tasks",
          "Inspection",
          "Disposal",
          "Pending",
        ].map((name) => (
          <Pressable key={name} style={s.button} onPress={() => setPanel(name)}>
            <Text style={s.white}>{name}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text accessibilityRole="alert">{error}</Text>}
      {info && <Text>{info}</Text>}
      {panel === "Routes" ? (
        <>
          <Text>Assigned routes and stop order</Text>
          {!(data.routes || []).length && (
            <Text>No collection routes assigned.</Text>
          )}
          {(data.routes || []).map((route: any) => (
            <View key={route.id} style={s.item}>
              <Text style={s.title}>{route.name}</Text>
              <Text>{route.service_date}</Text>
              {route.stops.map((stop: any) => {
                const current = jobs.find((j) => j.id === stop.id) || stop;
                return (
                  <View key={stop.id}>
                    <Text>
                      {stop.position}. {stop.customer_name} ·{" "}
                      {current.status.replaceAll("_", " ")}
                    </Text>
                    <Text>{stop.address}</Text>
                    {!["completed", "invoiced", "cancelled"].includes(
                      current.status,
                    ) && (
                      <Pressable
                        style={s.button}
                        onPress={() =>
                          void Linking.openURL(
                            "https://www.google.com/maps/dir/?api=1&destination=" +
                              encodeURIComponent(stop.address),
                          )
                        }
                      >
                        <Text style={s.white}>Navigate to this stop</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </>
      ) : panel === "Messages" ? (
        <>
          <Text>
            Dispatch messages{" "}
            {connected ? "· refreshes every 30 seconds" : "· saved copy"}
          </Text>
          {data.messages.slice(0, 30).map((m: any) => (
            <View key={m.id} style={s.item}>
              <Text>
                {m.sender_name} → {m.recipient_name}
              </Text>
              <Text>{m.message}</Text>
              <Text>{new Date(m.created_at).toLocaleString()}</Text>
              {!m.read_at && m.recipient_id === data.actor_id && (
                <Pressable
                  disabled={busy}
                  onPress={() =>
                    void save({
                      kind: "message_read",
                      messageId: m.id,
                      body: {},
                    })
                  }
                >
                  <Text>Acknowledge received message</Text>
                </Pressable>
              )}
            </View>
          ))}
          <Text>Office contact</Text>
          {data.contacts
            .filter((c: any) => c.role !== "driver")
            .map((c: any) => (
              <Pressable key={c.id} onPress={() => setRecipient(c.id)}>
                <Text>
                  {recipient === c.id ? "●" : "○"} {c.display_name} · {c.role}
                </Text>
              </Pressable>
            ))}
          <TextInput
            accessibilityLabel="Message to dispatch"
            placeholder="Message to dispatch"
            style={s.input}
            multiline
            maxLength={2000}
            value={message}
            onChangeText={setMessage}
          />
          <Pressable
            style={s.button}
            disabled={busy || !recipient || !message.trim()}
            onPress={() =>
              void save({
                kind: "message",
                body: { recipient_id: recipient, message: message.trim() },
              })
            }
          >
            <Text style={s.white}>Save outgoing message</Text>
          </Pressable>
        </>
      ) : panel === "Pending" ? (
        <>
          <Text>Pending driver updates</Text>
          <Text>
            Synchronize to send saved updates. If dispatch has changed the work,
            send the original evidence for office review. This keeps the
            evidence and removes only that update from this device's sending
            queue. Do not repeat physical service.
          </Text>
          {!actions.length && <Text>No pending driver tool updates.</Text>}
          {actions.map((action) => (
            <View key={action.key} style={s.item}>
              <Text>
                {action.kind.replaceAll("_", " ")} ·{" "}
                {new Date(action.performed_at).toLocaleString()}
              </Text>
              <Pressable
                disabled={busy || !connected}
                style={s.button}
                onPress={() =>
                  void (async () => {
                    setBusy(true);
                    setError("");
                    setInfo("");
                    try {
                      await submitActionReview(store, uid, action.key, api);
                      setActions(await pendingActions(store, uid));
                      await onQueueChange();
                      await load();
                      setInfo(
                        "Evidence saved for dispatch review. The original business record was not overwritten.",
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                <Text style={s.white}>
                  Send this update for dispatch review
                </Text>
              </Pressable>
            </View>
          ))}
        </>
      ) : panel === "Tasks" ? (
        <>
          <Text>Independent tasks — saved with your assigned work</Text>
          {!independentTasks.length && (
            <Text>No independent driver tasks assigned.</Text>
          )}
          {independentTasks.map((t: any) => (
            <View key={t.id} style={s.item}>
              <Text style={s.title}>{t.title}</Text>
              <Text>
                {t.scheduled_date} · {t.priority} ·{" "}
                {t.status.replaceAll("_", " ")}
              </Text>
              <Text>{t.description}</Text>
              {t.address && <Text>{t.address}</Text>}
              {t.completion_note && <Text>{t.completion_note}</Text>}
              {["assigned", "in_progress"].includes(t.status) && (
                <>
                  <Pressable
                    disabled={busy}
                    style={s.button}
                    onPress={() =>
                      void save({
                        kind: "driver_task",
                        taskId: t.id,
                        body: {
                          version: t.version,
                          status:
                            t.status === "assigned"
                              ? "in_progress"
                              : "completed",
                          note: "",
                          performed_at: new Date().toISOString(),
                        },
                      })
                    }
                  >
                    <Text style={s.white}>
                      {t.status === "assigned"
                        ? "Save task start"
                        : "Save task completion"}
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={busy}
                    onPress={() => {
                      setTaskFailureId(t.id);
                      setTaskFailure("");
                    }}
                  >
                    <Text>Unable to complete this task</Text>
                  </Pressable>
                  {taskFailureId === t.id && (
                    <>
                      <TextInput
                        accessibilityLabel="Independent task failure reason"
                        placeholder="Explain why the task could not be completed"
                        style={s.input}
                        multiline
                        value={taskFailure}
                        onChangeText={setTaskFailure}
                      />
                      <Pressable
                        disabled={busy || !taskFailure.trim()}
                        style={s.button}
                        onPress={() =>
                          void save({
                            kind: "driver_task",
                            taskId: t.id,
                            body: {
                              version: t.version,
                              status: "failed",
                              note: taskFailure.trim(),
                              performed_at: new Date().toISOString(),
                            },
                          })
                        }
                      >
                        <Text style={s.white}>Save task failure</Text>
                      </Pressable>
                    </>
                  )}
                </>
              )}
            </View>
          ))}
        </>
      ) : panel === "Inspection" ? (
        <>
          <Text>Assigned truck</Text>
          {trucks.map((t) => (
            <Pressable key={t.id} onPress={() => setTruck(t.id)}>
              <Text>
                {truck === t.id ? "●" : "○"} {t.number}
              </Text>
            </Pressable>
          ))}
          <View style={s.row}>
            {(["pre_trip", "post_trip"] as const).map((k) => (
              <Pressable key={k} onPress={() => setKind(k)}>
                <Text>
                  {kind === k ? "●" : "○"} {k.replace("_", " ")}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            accessibilityLabel="Odometer in kilometers"
            placeholder="Odometer (km)"
            keyboardType="numeric"
            style={s.input}
            value={odometer}
            onChangeText={setOdometer}
          />
          <Pressable onPress={() => setSafe(!safe)}>
            <Text>
              {safe ? "☑ Safe to operate" : "☒ Unsafe — stop using this truck"}
            </Text>
          </Pressable>
          <TextInput
            accessibilityLabel="Inspection notes"
            placeholder="Inspection notes / defects"
            style={s.input}
            multiline
            maxLength={2000}
            value={notes}
            onChangeText={setNotes}
          />
          {!safe && (
            <Text>
              Stop operating the truck and contact dispatch immediately. An
              offline inspection reaches dispatch after synchronization.
            </Text>
          )}
          <Pressable
            disabled={
              busy ||
              !truck ||
              !/^\d+$/.test(odometer) ||
              (!safe && !notes.trim())
            }
            style={s.button}
            onPress={() =>
              void save({
                kind: "inspection",
                body: {
                  truck_id: truck,
                  kind,
                  odometer_km: Number(odometer),
                  safe_to_operate: safe,
                  notes: notes.trim(),
                  recorded_at: new Date().toISOString(),
                },
              })
            }
          >
            <Text style={s.white}>Save vehicle inspection</Text>
          </Pressable>
          {data.inspections.slice(0, 5).map((i: any) => (
            <Text key={i.id}>
              {i.truck_number} · {i.kind.replace("_", " ")} ·{" "}
              {i.safe_to_operate ? "Safe" : "Defects reported"} ·{" "}
              {new Date(i.recorded_at || i.created_at).toLocaleString()}
            </Text>
          ))}
        </>
      ) : (
        <>
          <Text>
            Record the facility's verified ticket after collecting a load.
            Weights are in kilograms; cost is in USD.
          </Text>
          {pickups.length === 0 && (
            <Text>No completed rental loads available.</Text>
          )}
          {pickups.map((j) => (
            <Pressable key={j.id} onPress={() => setDisposalJob(j.id)}>
              <Text>
                {disposalJob === j.id ? "●" : "○"} {j.customer_name} ·{" "}
                {j.rental_action}
              </Text>
            </Pressable>
          ))}
          {selected && (
            <>
              <Text>
                {selected.last_failure_reason ||
                  "Container remains unavailable until a verified disposal ticket is recorded."}
              </Text>
              <TextInput
                accessibilityLabel="Unable to dump reason"
                placeholder="Why could the load not be dumped?"
                style={s.input}
                multiline
                maxLength={2000}
                value={dumpReason}
                onChangeText={setDumpReason}
              />
              <Pressable onPress={() => setReturnLater(!returnLater)}>
                <Text>
                  {returnLater
                    ? "☑ Returning later — keep on my schedule"
                    : "☐ Return to dispatch for reassignment"}
                </Text>
              </Pressable>
              <Pressable
                disabled={busy || !dumpReason.trim()}
                style={s.button}
                onPress={() =>
                  void save({
                    kind: "unable_dump",
                    loadId: selected.id,
                    body: {
                      version: selected.version,
                      reason: dumpReason.trim(),
                      returning_later: returnLater,
                      performed_at: new Date().toISOString(),
                    },
                  })
                }
              >
                <Text style={s.white}>Save unable-to-dump report</Text>
              </Pressable>
            </>
          )}
          <TextInput
            accessibilityLabel="Disposal facility"
            placeholder="Disposal facility"
            style={s.input}
            value={facility}
            onChangeText={setFacility}
          />
          <TextInput
            accessibilityLabel="Facility ticket number"
            placeholder="Facility ticket number"
            style={s.input}
            value={ticket}
            onChangeText={setTicket}
          />
          <TextInput
            accessibilityLabel="Gross weight in kilograms"
            placeholder="Gross kg"
            keyboardType="numeric"
            style={s.input}
            value={gross}
            onChangeText={setGross}
          />
          <TextInput
            accessibilityLabel="Tare weight in kilograms"
            placeholder="Tare kg"
            keyboardType="numeric"
            style={s.input}
            value={tare}
            onChangeText={setTare}
          />
          <TextInput
            accessibilityLabel="Disposal cost in dollars"
            placeholder="Disposal cost (USD)"
            keyboardType="decimal-pad"
            style={s.input}
            value={cost}
            onChangeText={setCost}
          />
          <Pressable
            style={s.button}
            disabled={
              busy ||
              !disposalJob ||
              !facility.trim() ||
              !ticket.trim() ||
              !/^\d+$/.test(gross) ||
              !/^\d+$/.test(tare) ||
              Number(gross) < Number(tare) ||
              !/^\d+(\.\d{1,2})?$/.test(cost)
            }
            onPress={() => {
              const j = pickups.find((j) => j.id === disposalJob)!;
              const parts = cost.split(".");
              void save({
                kind: "disposal",
                rentalId: j.rental_id,
                body: {
                  order_id: j.order_id,
                  facility: facility.trim(),
                  ticket_number: ticket.trim(),
                  gross_kg: Number(gross),
                  tare_kg: Number(tare),
                  disposal_cost_cents:
                    Number(parts[0]) * 100 +
                    Number((parts[1] || "").padEnd(2, "0")),
                },
              });
            }}
          >
            <Text style={s.white}>Save disposal ticket</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  card: { padding: 20, backgroundColor: "white", gap: 12, borderRadius: 8 },
  title: { fontSize: 22, fontWeight: "700" },
  row: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  button: { backgroundColor: "#186b50", padding: 12, borderRadius: 5 },
  white: { color: "white", fontWeight: "600" },
  input: {
    padding: 12,
    borderWidth: 1,
    borderColor: "#ccd7d1",
    borderRadius: 5,
  },
  item: {
    paddingVertical: 8,
    gap: 5,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
});
