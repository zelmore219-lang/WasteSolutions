const fs = require("node:fs/promises");
const path = require("node:path");
const {
  NtExecutable,
  NtExecutableResource,
  Resource,
  Data,
} = require("resedit");
async function brandExecutable(executable, icon) {
  const pe = NtExecutable.from(await fs.readFile(executable), {
    ignoreCert: true,
  });
  const resources = NtExecutableResource.from(pe);
  const untouched = resources.entries
    .filter((e) => e.type !== 3 && e.type !== 14)
    .map((e) => ({
      type: e.type,
      id: e.id,
      lang: e.lang,
      bin: Buffer.from(e.bin),
    }));
  const images = Data.IconFile.from(await fs.readFile(icon)).icons.map(
    (i) => i.data,
  );
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  for (const group of groups.length ? groups : [{ id: 101, lang: 1033 }])
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      group.id,
      group.lang,
      images,
    );
  resources.outputResource(pe);
  const output = Buffer.from(pe.generate());
  const check = NtExecutableResource.from(NtExecutable.from(output));
  for (const before of untouched) {
    const after = check.entries.find(
      (e) =>
        e.type === before.type && e.id === before.id && e.lang === before.lang,
    );
    if (!after || !Buffer.from(after.bin).equals(before.bin))
      throw Error("Branding changed a non-icon executable resource");
  }
  await fs.writeFile(executable, output);
}
module.exports = async (context) => {
  if (context.electronPlatformName === "win32")
    await brandExecutable(
      path.join(
        context.appOutDir,
        context.packager.appInfo.productFilename + ".exe",
      ),
      path.join(__dirname, "assets/app-icon.ico"),
    );
};
module.exports.brandExecutable = brandExecutable;
