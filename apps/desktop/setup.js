const bridge = window.corewasteConnection,
  field = document.getElementById("server"),
  message = document.getElementById("message");
message.textContent = new URLSearchParams(location.search).get("message") || "";
async function localStatus() {
  const status = await bridge.localStatus();
  document.getElementById("local-status").textContent = status.message;
  const busy = [
    "checking",
    "verifying",
    "importing",
    "starting",
    "stopping",
  ].includes(status.phase);
  document.getElementById("local-start").disabled = busy;
  document.getElementById("local-stop").disabled = busy;
  document.getElementById("local-open").disabled = status.phase !== "ready";
}
async function localAction(action) {
  message.textContent = "";
  try {
    await action();
    await localStatus();
  } catch (error) {
    message.textContent =
      error.message || "The local action could not be completed.";
  }
}
bridge
  .read()
  .then(({ url, local_test }) => {
    field.value = url;
    if (local_test) {
      document.querySelector("h1").textContent = "CoreWaste local test kit";
      document.getElementById("connection").hidden = true;
      document.getElementById("hosted-help").hidden = true;
      document.getElementById("hosted-hint").hidden = true;
      document.getElementById("local-test").hidden = false;
      document.querySelector("h1+p").textContent =
        "Start your local test services, view your sign-ins, and open the app.";
      void localStatus().catch((error) => {
        message.textContent = error.message;
      });
      setInterval(() => void localStatus().catch(() => {}), 1500);
    }
  })
  .catch(() => {
    message.textContent = "Could not read connection settings.";
  });
document
  .getElementById("connection")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("connect");
    button.disabled = true;
    message.textContent = "Connecting…";
    try {
      const result = await bridge.connect(field.value);
      if (!result.ok) message.textContent = result.message;
    } catch {
      message.textContent = "Could not save the connection. Please try again.";
    } finally {
      button.disabled = false;
    }
  });
document
  .getElementById("local-start")
  .addEventListener("click", () => void localAction(() => bridge.localStart()));
document
  .getElementById("local-stop")
  .addEventListener("click", () => void localAction(() => bridge.localStop()));
document.getElementById("local-open").addEventListener(
  "click",
  () =>
    void localAction(async () => {
      const result = await bridge.connect("http://127.0.0.1:8088/office");
      if (!result.ok) throw Error(result.message);
    }),
);
document.getElementById("local-logins").addEventListener(
  "click",
  () =>
    void localAction(async () => {
      const accounts = await bridge.localLogins(),
        output = document.getElementById("local-logins-output");
      output.replaceChildren();
      for (const account of accounts) {
        const item = document.createElement("p");
        item.className = "test-login";
        item.textContent =
          account.role +
          " · " +
          account.email +
          "\nPassword: " +
          account.password;
        output.appendChild(item);
      }
    }),
);
document.getElementById("local-codes").addEventListener(
  "click",
  () =>
    void localAction(async () => {
      const codes = await bridge.localCodes();
      document.getElementById("local-code-output").textContent = codes.length
        ? codes.map((code) => code.phone + ": " + code.code).join(" · ")
        : "Request a verification code from the owner sign-in form first.";
    }),
);
