import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
const require = createRequire(import.meta.url);
const assets = require("@expo/metro/metro/Assets");
test("Expo Metro patch preserves PNG/JPEG/SVG dimensions and Android/iOS scaled asset metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corewaste-assets-"));
  try {
    const png = await sharp({
      create: { width: 13, height: 7, channels: 4, background: "#147d64" },
    })
      .png()
      .toBuffer();
    const large = await sharp(png).resize(26, 14).png().toBuffer(),
      jpeg = await sharp(png).jpeg().toBuffer();
    assert.deepEqual(assets.getAssetSize("png", png, "icon.png"), {
      width: 13,
      height: 7,
    });
    assert.deepEqual(assets.getAssetSize("jpg", jpeg, "icon.jpg"), {
      width: 13,
      height: 7,
    });
    assert.deepEqual(
      assets.getAssetSize(
        "svg",
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="7"></svg>',
        ),
        "icon.svg",
      ),
      { width: 13, height: 7 },
    );
    await writeFile(join(dir, "icon.png"), png);
    await writeFile(join(dir, "icon@2x.png"), large);
    for (const platform of ["android", "ios"]) {
      const asset = await assets.getAssetData(
        join(dir, "icon.png"),
        "icon.png",
        [],
        platform,
        "/assets",
      );
      assert.equal(asset.width, 13);
      assert.equal(asset.height, 7);
      assert.deepEqual(asset.scales, [1, 2]);
      assert.equal(asset.files.length, 2);
      assert.match(asset.hash, /^[0-9a-f]{32}$/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("malformed image containers reject in a bounded subprocess instead of hanging the asset build", () => {
  const script =
    "const a=require('@expo/metro/metro/Assets');const assert=require('node:assert/strict');const icns=Buffer.alloc(32);icns.write('icns');icns.writeUInt32BE(32,4);icns.write('ic07',8);icns.writeUInt32BE(0,12);for(const b of [icns,Buffer.from('ftypheic00000000'),Buffer.from([0xff,0x0a,0,0,0,0]),Buffer.from('not a png')])assert.throws(()=>a.getAssetSize('png',b,'malformed.png'));";
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    timeout: 3000,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
