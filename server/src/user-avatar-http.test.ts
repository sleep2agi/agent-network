import { expect, test } from "bun:test";
import { register, login, createNetworkTokenForNode, addNetworkMember } from "./auth.js";
import { db } from "./db.js";

// One sequential HTTP scenario: fail a prerequisite before running the next layer.
// Docker supplies an isolated DB; never import this against a production DB.
test("human avatar: auth → save/read/login → member visibility → isolation/rejection → clear", async () => {
  const a = register("avatar_alice", "AvatarPassw0rd!");
  const b = register("avatar_bob", "AvatarPassw0rd!");
  const stranger = register("avatar_stranger", "AvatarPassw0rd!");
  expect(a.ok && b.ok && stranger.ok).toBe(true);
  expect(addNetworkMember(a.network_id!, b.user!.user_id, "member").ok).toBe(true);
  const node = createNetworkTokenForNode(a.user!.user_id, a.network_id!, "avatar_alice", "avatar_node");
  expect(node.ok).toBe(true);
  const { bootServer } = await import("./server.js");
  const hub = bootServer({ port: 0, hostname: "127.0.0.1" });
  const base = `http://127.0.0.1:${hub.port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const put = (token: string, body: unknown) => call(token, "PUT", "/api/auth/me/avatar", body);
  const me = (token: string) => call(token, "GET", "/api/auth/me");
  try {
    expect((await me(a.token!)).status).toBe(200);
    expect((await me(a.token!)).body.user.avatar_url).toBeNull();
    expect((await put("invalid", { avatar_url: null })).status).toBe(401);
    expect((await put(node.token!, { avatar_url: null })).status).toBe(403);

    const avatar = "/avatars/avatar-03.webp";
    const saved = await put(a.token!, { avatar_url: avatar });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ok: true, user_id: a.user!.user_id, avatar_url: avatar });
    expect((await me(a.token!)).body.user.avatar_url).toBe(avatar);
    const secondDevice = login("avatar_alice", "AvatarPassw0rd!");
    expect(secondDevice.ok).toBe(true);
    expect(secondDevice.user!.avatar_url).toBe(avatar);
    expect((await me(secondDevice.token!)).body.user.avatar_url).toBe(avatar);
    // An ordinary profile edit must preserve and return the saved avatar.
    const profile = await call(a.token!, "PUT", "/api/auth/me", { display_name: "Alice" });
    expect(profile.status).toBe(200);
    expect(profile.body.user.avatar_url).toBe(avatar);
    const people = await call(b.token!, "GET", `/api/networks/${a.network_id}/humans`);
    expect(people.status).toBe(200);
    expect(people.body.humans.find((u: any) => u.user_id === a.user!.user_id).avatar_url).toBe(avatar);
    expect((await call(stranger.token!, "GET", `/api/networks/${a.network_id}/humans`)).status).toBe(403);
    expect((await me(b.token!)).body.user.avatar_url).toBeNull();

    for (const body of [null, [], {}, { avatar_url: avatar, user_id: b.user!.user_id },
      ...[123, {}, "javascript:alert(1)", "file:///tmp/photo.png", "data:image/png;base64,AAAA",
        "//evil.example/a.png", "/avatars/../x.png", "https://user:secret@example.com/x.png", "x".repeat(3000)]
        .map((avatar_url) => ({ avatar_url }))]) {
      expect((await put(a.token!, body)).status).toBe(400);
      expect((await me(a.token!)).body.user.avatar_url).toBe(avatar);
    }
    const malformed = await fetch(base + "/api/auth/me/avatar", { method: "PUT",
      headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    expect((await put(node.token!, { avatar_url: "/avatars/avatar-09.webp" })).status).toBe(403);
    expect((await me(a.token!)).body.user.avatar_url).toBe(avatar);
    expect((await me(b.token!)).body.user.avatar_url).toBeNull();
    expect(db.get<any>("SELECT avatar_url FROM nodes WHERE node_id = ?1", "avatar_node")?.avatar_url ?? null).toBeNull();

    const remote = "https://example.invalid/photo.png";
    expect((await put(a.token!, { avatar_url: remote })).status).toBe(200);
    expect((await me(a.token!)).body.user.avatar_url).toBe(remote);
    expect((await put(a.token!, { avatar_url: null })).status).toBe(200);
    expect((await me(secondDevice.token!)).body.user.avatar_url).toBeNull();
    expect((await put(a.token!, { avatar_url: avatar })).status).toBe(200);
    expect((await put(a.token!, { avatar_url: "  " })).body.avatar_url).toBeNull();
  } finally { hub.stop(true); }
}, 30_000);
