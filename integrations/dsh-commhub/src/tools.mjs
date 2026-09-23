// Tool specs the plugin exposes to the DSH agent. Kept DSH-independent so the
// handlers can be unit-tested; plugin.mjs wraps them with defineTool().

export function commhubToolSpecs(client, alias) {
  return [
    {
      name: "commhub_send_task",
      description: "Send a task to another agent on the Agent Network (CommHub) by alias. The target will reply later; returns the task id.",
      parameters: {
        alias: { type: "string", required: true, description: "Target agent alias (use commhub_get_all_status to list)" },
        task: { type: "string", required: true, description: "Task text" },
      },
      async handler(args) {
        const r = await client.call("send_task", { alias: args.alias, task: args.task, priority: "normal", from_session: alias });
        return { ok: true, id: String(r.message_id ?? r.task_id ?? ""), queued: r.queued === true };
      },
      render: (v) => (v.queued ? `task queued ${v.id} (target offline; delivered when it reconnects)` : `task sent ${v.id}`),
    },
    {
      name: "commhub_send_message",
      description: "Send an informational message to another agent by alias (no reply expected). Returns the message id.",
      parameters: {
        alias: { type: "string", required: true, description: "Target agent alias" },
        message: { type: "string", required: true, description: "Message text" },
      },
      async handler(args) {
        const r = await client.call("send_message", { alias: args.alias, message: args.message, from_session: alias });
        return { ok: true, id: String(r.message_id ?? r.id ?? ""), queued: r.queued === true };
      },
      render: (v) => (v.queued ? `message queued ${v.id} (target offline; delivered when it reconnects)` : `message sent ${v.id}`),
    },
    {
      name: "commhub_get_all_status",
      description: "List agents on the Agent Network with their status, so you can pick a real alias before sending.",
      parameters: {},
      async handler() {
        const r = await client.call("get_all_status", {});
        const rows = Array.isArray(r) ? r : (r.sessions ?? r.agents ?? []);
        const agents = rows.slice(0, 200).map((s) => ({ alias: String(s.alias ?? ""), status: String(s.status ?? ""), agent: String(s.agent ?? "") }));
        return { ok: true, id: `${agents.length}`, agents };
      },
      render: (v) => (v.agents ?? []).map((a) => `${a.alias} (${a.status})`).join("\n") || "no agents",
    },
  ];
}
