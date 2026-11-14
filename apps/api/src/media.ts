import { SupabasePrivateStorage } from "./supabase-storage";
import { providerValue } from "./provider-runtime";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PoolClient } from "pg";
import { z } from "zod";
import { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  Actor,
  Operations,
  OFFICE,
  FINANCE,
  parse,
  permit,
  uuid,
} from "./domain";
type File = { buffer: Buffer; originalname: string };
export class Media {
  constructor(
    readonly ops: Operations,
    private readonly supabase: Pick<
      SupabasePrivateStorage,
      "upload" | "download"
    > = new SupabasePrivateStorage(),
  ) {}
  async allowed(
    c: Pick<PoolClient, "query">,
    a: Actor,
    kind: string,
    id: string,
    visibility?: string,
    history = false,
  ) {
    permit(a, [...OFFICE, ...FINANCE, "driver", "customer"]);
    if (a.role === "customer" && visibility === "office")
      throw new ForbiddenException();
    if (kind === "customer") {
      if (
        a.role === "driver" ||
        (a.role === "customer" && a.customer_id !== id)
      )
        throw new ForbiddenException();
      if (
        !(await c.query("SELECT 1 FROM customers WHERE id=$1", [id])).rowCount
      )
        throw new NotFoundException();
    } else {
      const order = (await c.query("SELECT * FROM orders WHERE id=$1", [id]))
        .rows[0];
      if (!order) throw new NotFoundException();
      if (
        (a.role === "driver" &&
          order.driver_id !== a.id &&
          !(
            history &&
            (
              await c.query(
                "SELECT 1 FROM order_events WHERE order_id=$1 AND driver_id=$2 AND created_at>now()-interval '7 days'",
                [id, a.id],
              )
            ).rowCount
          )) ||
        (a.role === "customer" && order.customer_id !== a.customer_id)
      )
        throw new ForbiddenException();
    }
  }
  async upload(
    a: Actor,
    key: string | undefined,
    body: unknown,
    file: File | undefined,
  ) {
    const b = parse(
      z
        .object({
          entity_kind: z.enum(["order", "customer"]),
          entity_id: uuid,
          kind: z.enum(["photo", "document", "signature"]),
          visibility: z.enum(["office", "customer"]).default("office"),
          signer_name: z.string().trim().min(1).max(200).optional(),
          signed_at: z.iso.datetime().optional(),
          captured_at: z.iso.datetime().optional(),
        })
        .strict(),
      body,
    );
    await this.allowed(
      this.ops.pool,
      a,
      b.entity_kind,
      b.entity_id,
      undefined,
      true,
    );
    if (!file?.buffer?.length || file.buffer.length > 10485760)
      throw new BadRequestException("Select a file between 1 byte and 10 MB");
    const originalHash = createHash("sha256").update(file.buffer).digest("hex");
    return this.ops.command(
      a,
      key,
      ["attachment", b, originalHash],
      async (c) => {
        await this.allowed(c, a, b.entity_kind, b.entity_id, undefined, true);
        let buffer: Buffer, contentType: string;
        const png = file.buffer
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
          jpeg = file.buffer[0] === 255 && file.buffer[1] === 216;
        if (png || jpeg) {
          try {
            const image = sharp(file.buffer, {
              limitInputPixels: 16000000,
              failOn: "error",
            }).rotate();
            buffer =
              b.kind === "signature"
                ? await image.png().toBuffer()
                : await image
                    .flatten({ background: "#ffffff" })
                    .jpeg({ quality: 88 })
                    .toBuffer();
            contentType = b.kind === "signature" ? "image/png" : "image/jpeg";
          } catch {
            throw new BadRequestException(
              "Image is invalid or exceeds 16 megapixels",
            );
          }
        } else if (
          b.kind === "document" &&
          file.buffer.subarray(0, 5).toString() === "%PDF-"
        ) {
          buffer = file.buffer;
          contentType = "application/pdf";
        } else
          throw new BadRequestException(
            "Use a JPEG or PNG image, or a PDF document",
          );
        if (buffer.length > 10485760)
          throw new BadRequestException("Processed file exceeds 10 MB");
        if (b.kind === "signature" && (!b.signer_name || !b.signed_at))
          throw new BadRequestException(
            "Signature requires signer name and signing time",
          );
        for (const timestamp of [b.signed_at, b.captured_at])
          if (
            timestamp &&
            (Date.now() - Date.parse(timestamp) > 7 * 86400000 ||
              Date.parse(timestamp) > Date.now() + 300000)
          )
            throw new BadRequestException(
              "Capture and signing times must be within the last seven days",
            );
        const digest = createHash("sha256")
          .update(a.id + ":" + key)
          .digest("hex");
        const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        const sha256 = createHash("sha256").update(buffer).digest("hex"),
          storageKey = "attachments/" + id;
        const driver =
          providerValue("STORAGE_DRIVER") ||
          (process.env.NODE_ENV === "production" ? "gcs" : "local");
        if (driver === "local") {
          if (process.env.NODE_ENV === "production")
            throw new ServiceUnavailableException(
              "Production requires cloud document storage",
            );
          const directory = resolve(
            process.env.LOCAL_STORAGE_DIR || ".local/uploads",
          );
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, id);
          try {
            await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (
              createHash("sha256")
                .update(await readFile(path))
                .digest("hex") !== sha256
            )
              throw new ServiceUnavailableException(
                "Stored attachment checksum does not match",
              );
          }
        } else if (driver === "gcs") {
          if (!providerValue("GCS_BUCKET"))
            throw new ServiceUnavailableException(
              "Cloud document storage is not configured",
            );
          const object = new Storage()
            .bucket(providerValue("GCS_BUCKET")!)
            .file(storageKey);
          try {
            await object.save(buffer, {
              resumable: false,
              validation: "crc32c",
              preconditionOpts: { ifGenerationMatch: 0 },
              metadata: { contentType, metadata: { sha256 } },
            });
          } catch (error) {
            if ((error as { code?: number }).code !== 412) throw error;
            const [metadata] = await object.getMetadata();
            if (metadata.metadata?.sha256 !== sha256)
              throw new ServiceUnavailableException(
                "Cloud attachment checksum does not match",
              );
          }
        } else if (driver === "supabase") {
          await this.supabase.upload(storageKey, buffer, contentType, sha256);
        } else
          throw new ServiceUnavailableException(
            "Document storage driver is invalid",
          );
        const filename =
          file.originalname
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .replace(/^\.+/, "")
            .slice(0, 120) || "attachment";
        const row = (
          await c.query(
            "INSERT INTO attachments(id,order_id,customer_id,kind,filename,content_type,size_bytes,sha256,storage_driver,storage_key,visibility,actor_id,signer_name,signed_at,consent_version,captured_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,order_id,customer_id,kind,filename,content_type,size_bytes,visibility,signer_name,signed_at,created_at",
            [
              id,
              b.entity_kind === "order" ? b.entity_id : null,
              b.entity_kind === "customer" ? b.entity_id : null,
              b.kind,
              filename,
              contentType,
              buffer.length,
              sha256,
              driver,
              storageKey,
              a.role === "customer" ? "customer" : b.visibility,
              a.id,
              b.signer_name || null,
              b.signed_at || null,
              b.kind === "signature" ? "service-receipt-v1" : null,
              b.captured_at || null,
            ],
          )
        ).rows[0];
        await this.ops.audit(c, a, "attachment.created", id, { kind: b.kind });
        return row;
      },
    );
  }
  async list(a: Actor, kind: string, id: string) {
    parse(z.enum(["order", "customer"]), kind);
    parse(uuid, id);
    await this.allowed(this.ops.pool, a, kind, id);
    return (
      await this.ops.pool.query(
        "SELECT id,kind,filename,content_type,size_bytes,visibility,signer_name,signed_at,created_at FROM attachments WHERE (($1='order' AND order_id=$2) OR ($1='customer' AND customer_id=$2)) AND ($3::boolean OR visibility='customer') ORDER BY created_at DESC",
        [kind, id, a.role !== "customer"],
      )
    ).rows;
  }
  async download(a: Actor, id: string) {
    parse(uuid, id);
    const row = (
      await this.ops.pool.query("SELECT * FROM attachments WHERE id=$1", [id])
    ).rows[0];
    if (!row) throw new NotFoundException();
    await this.allowed(
      this.ops.pool,
      a,
      row.order_id ? "order" : "customer",
      row.order_id || row.customer_id,
      row.visibility,
    );
    let data: Buffer;
    if (row.storage_driver === "local") {
      if (process.env.NODE_ENV === "production")
        throw new ServiceUnavailableException(
          "Local attachment storage is unavailable in production",
        );
      data = await readFile(
        join(
          resolve(process.env.LOCAL_STORAGE_DIR || ".local/uploads"),
          row.id,
        ),
      );
    } else if (row.storage_driver === "supabase") {
      data = await this.supabase.download(row.storage_key);
    } else {
      if (!providerValue("GCS_BUCKET"))
        throw new ServiceUnavailableException(
          "Cloud document storage is unavailable",
        );
      [data] = await new Storage()
        .bucket(providerValue("GCS_BUCKET")!)
        .file(row.storage_key)
        .download({ validation: "crc32c" });
    }
    if (createHash("sha256").update(data).digest("hex") !== row.sha256)
      throw new ServiceUnavailableException(
        "Attachment integrity check failed",
      );
    return { ...row, data };
  }
}
