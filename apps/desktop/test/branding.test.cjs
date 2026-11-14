const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { NtExecutable, NtExecutableResource, Resource } = require("resedit");
const { brandExecutable } = require("../brand-windows.cjs");
test("Windows icon replacement preserves embedded application-integrity resources", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "corewaste-icon-"));
  try {
    const file = path.join(directory, "CoreWaste.exe");
    const executable = NtExecutable.createEmpty(false, false);
    const resources = NtExecutableResource.from(executable);
    const integrity = Buffer.from('{"app.asar":"test-integrity-resource"}');
    resources.entries.push({
      type: 10,
      id: "INTEGRITY",
      lang: 1033,
      codepage: 0,
      bin: integrity.buffer.slice(
        integrity.byteOffset,
        integrity.byteOffset + integrity.byteLength,
      ),
    });
    resources.outputResource(executable);
    await fs.writeFile(file, Buffer.from(executable.generate()));
    await brandExecutable(file, path.join(__dirname, "../assets/app-icon.ico"));
    const output = NtExecutableResource.from(
      NtExecutable.from(await fs.readFile(file)),
    );
    assert.deepEqual(
      Buffer.from(output.entries.find((e) => e.id === "INTEGRITY").bin),
      integrity,
    );
    const groups = Resource.IconGroupEntry.fromEntries(output.entries);
    assert.ok(groups.length);
    assert.equal(groups[0].icons.length, 6);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
