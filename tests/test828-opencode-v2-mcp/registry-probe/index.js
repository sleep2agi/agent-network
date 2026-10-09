// Docker experiment only, not installed by ANet runtime.
// No tool execution or credential disclosure: observe the final tool registry.
export default {
  id: "anet.registry-probe",
  async setup(ctx) {
    const registration = await ctx.rpc.register({
      id: "anet.registry-probe",
      events: {},
      methods: {
        ready: {
          input: { type: "object", properties: {}, additionalProperties: false },
          output: {
            type: "object",
            properties: { ready: { type: "boolean" } },
            required: ["ready"], additionalProperties: false,
          },
        },
      },
    }, {
      ready: async () => {
        const tools = await ctx.tool.list();
        const required = ctx.options.missing ? ["commhub_nonexistent_probe"] : ["commhub_send_task", "commhub_get_task"];
        return { ready: required.every(id => tools.some(tool => tool.id === id)) };
      },
    });
    return () => registration.dispose();
  },
};
