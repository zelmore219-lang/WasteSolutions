import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { Actor, Operations, OFFICE, parse, permit, uuid } from "./domain";
export class OrderTasks {
  constructor(readonly ops: Operations) {}
  async add(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          label: z.string().trim().min(1).max(500),
          required: z.boolean(),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["task.add", id, b], async (c) => {
      const order = await this.ops.locked(c, id);
      if (
        order.version !== b.version ||
        !["new", "assigned", "in_progress"].includes(order.status)
      )
        throw new ConflictException("Order changed or no longer accepts tasks");
      if (
        Number(
          (
            await c.query(
              "SELECT count(*) AS n FROM order_tasks WHERE order_id=$1",
              [id],
            )
          ).rows[0].n,
        ) >= 30
      )
        throw new BadRequestException("An order supports up to 30 tasks");
      const task = (
        await c.query(
          "INSERT INTO order_tasks(order_id,label,required,created_by) VALUES($1,$2,$3,$4) RETURNING *",
          [id, b.label, b.required, a.id],
        )
      ).rows[0];
      await c.query("UPDATE orders SET version=version+1 WHERE id=$1", [id]);
      await this.ops.audit(c, a, "order.task_added", id, {
        task_id: task.id,
        required: b.required,
      });
      return { ...task, customer_id: order.customer_id };
    });
  }
  async complete(
    a: Actor,
    key: string | undefined,
    id: string,
    taskId: string,
    body: unknown,
  ) {
    permit(a, ["owner", "manager", "driver"]);
    parse(uuid, id);
    parse(uuid, taskId);
    const b = parse(
      z
        .object({
          version: z.number().int().positive(),
          note: z.string().trim().max(2000),
          performed_at: z.iso.datetime(),
        })
        .strict(),
      body,
    );
    if (
      Date.parse(b.performed_at) > Date.now() + 300000 ||
      Date.now() - Date.parse(b.performed_at) > 7 * 86400000
    )
      throw new BadRequestException(
        "Task timestamp must be within the last seven days",
      );
    return this.ops.command(
      a,
      key,
      ["task.complete", id, taskId, b],
      async (c) => {
        const order = await this.ops.locked(c, id);
        if (a.role === "driver" && order.driver_id !== a.id)
          throw new ForbiddenException();
        if (!["assigned", "in_progress"].includes(order.status))
          throw new ConflictException(
            "Tasks require assigned or in-progress work",
          );
        const task = (
          await c.query(
            "SELECT * FROM order_tasks WHERE id=$1 AND order_id=$2 FOR UPDATE",
            [taskId, id],
          )
        ).rows[0];
        if (!task) throw new NotFoundException("Task not found");
        if (task.completed_at || task.version !== b.version)
          throw new ConflictException("Task changed or is already complete");
        const row = (
          await c.query(
            "UPDATE order_tasks SET completed_by=$2,completed_at=$3,completion_note=$4,version=version+1 WHERE id=$1 RETURNING *",
            [taskId, a.id, b.performed_at, b.note],
          )
        ).rows[0];
        await this.ops.audit(c, a, "order.task_completed", id, {
          task_id: taskId,
          performed_at: b.performed_at,
          note: b.note,
        });
        return { ...row, customer_id: order.customer_id };
      },
    );
  }
}
