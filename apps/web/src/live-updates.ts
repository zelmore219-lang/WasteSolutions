export async function watchChanges(
  token: () => Promise<string>,
  refresh: () => Promise<void>,
  signal: AbortSignal,
) {
  let lastRefresh = 0,
    pending: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    if (pending) return;
    pending = setTimeout(
      () => {
        pending = undefined;
        if (!signal.aborted) {
          lastRefresh = Date.now();
          void refresh().catch(() => {
            /* Normal requests surface authorization or connectivity errors. */
          });
        }
      },
      Math.max(3000 - (Date.now() - lastRefresh), 0),
    );
  };
  try {
    while (!signal.aborted) {
      try {
        const response = await fetch("/api/events", {
          headers: { Authorization: `Bearer ${await token()}` },
          signal,
        });
        if (response.status === 401 || response.status === 403) return;
        if (!response.ok || !response.body)
          throw Error("Live connection unavailable");
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder
              .decode(chunk.value, { stream: true })
              .replaceAll("\r\n", "\n");
            let index;
            while ((index = buffer.indexOf("\n\n")) >= 0) {
              const event = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              if (event.includes("event: refresh")) update();
            }
            if (buffer.length > 65536) throw Error("Live event exceeds limit");
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      } catch {
        if (signal.aborted) return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 1000);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally {
    if (pending) clearTimeout(pending);
  }
}
