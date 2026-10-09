import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { chatMessagesSchema } from "../src/db/migrations/016_chat_messages.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ChatRepository } from "../src/domain/chat-repository.js";

describe("ChatRepository", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let chatRepo: ChatRepository;
  let rigId: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, chatMessagesSchema]);
    rigRepo = new RigRepository(db);
    chatRepo = new ChatRepository(db);
    const rig = rigRepo.createRig("test-rig");
    rigId = rig.id;
  });

  afterEach(() => {
    db.close();
  });

  it("send 使用 ULID 持久化消息", () => {
    const msg = chatRepo.send(rigId, "alice", "hello world");
    expect(msg.id).toBeTruthy();
    expect(msg.id.length).toBe(26); // ULID 长度为 26 个字符。
    expect(msg.rigId).toBe(rigId);
    expect(msg.sender).toBe("alice");
    expect(msg.body).toBe("hello world");
    expect(msg.kind).toBe("message");
    expect(msg.createdAt).toBeTruthy();
  });

  it("history 按时间顺序返回消息", () => {
    chatRepo.send(rigId, "alice", "first");
    chatRepo.send(rigId, "bob", "second");
    chatRepo.send(rigId, "alice", "third");

    const messages = chatRepo.history(rigId);
    expect(messages).toHaveLength(3);
    expect(messages[0]!.body).toBe("first");
    expect(messages[1]!.body).toBe("second");
    expect(messages[2]!.body).toBe("third");
  });

  it("history --topic 返回当前主题标记与下一主题标记之间的消息", () => {
    chatRepo.send(rigId, "alice", "before topic");
    chatRepo.sendTopic(rigId, "alice", "deploy", "starting deploy");
    chatRepo.send(rigId, "bob", "deploy message");
    chatRepo.send(rigId, "alice", "another deploy msg");
    chatRepo.sendTopic(rigId, "bob", "standup", "daily standup");
    chatRepo.send(rigId, "bob", "standup message — should NOT appear");

    const messages = chatRepo.history(rigId, { topic: "deploy" });
    const bodies = messages.map((m) => m.body);
    // 应包含 deploy 主题标记和该主题内的消息。
    expect(bodies).toContain("starting deploy");
    expect(bodies).toContain("deploy message");
    expect(bodies).toContain("another deploy msg");
    // 不应包含下一主题的消息。
    expect(bodies).not.toContain("daily standup");
    expect(bodies).not.toContain("standup message — should NOT appear");
  });

  it("sendTopic 创建 topic 类型的消息", () => {
    const msg = chatRepo.sendTopic(rigId, "alice", "standup", "daily standup");
    expect(msg.kind).toBe("topic");
    expect(msg.topic).toBe("standup");
    expect(msg.body).toBe("daily standup");
    expect(msg.sender).toBe("alice");
  });

  // 清理相关测试。
  it("clear 删除目标工作组的全部消息", () => {
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");
    chatRepo.send(rigId, "alice", "msg3");

    const result = chatRepo.clear(rigId);
    expect(result.deleted).toBe(3);
    expect(chatRepo.history(rigId)).toHaveLength(0);
  });

  it("房间为空时 clear 返回 0", () => {
    const result = chatRepo.clear(rigId);
    expect(result.deleted).toBe(0);
  });

  it("clear 保留其他工作组的消息", () => {
    const otherRig = rigRepo.createRig("other-rig");
    const otherRigId = otherRig.id;
    chatRepo.send(rigId, "alice", "target rig msg");
    chatRepo.send(otherRigId, "bob", "other rig msg");

    chatRepo.clear(rigId);

    expect(chatRepo.history(rigId)).toHaveLength(0);
    expect(chatRepo.history(otherRigId)).toHaveLength(1);
    expect(chatRepo.history(otherRigId)[0]!.body).toBe("other rig msg");
  });

  // history 过滤测试。
  it("history --sender 仅返回发送者匹配的消息", () => {
    chatRepo.send(rigId, "alice", "alice msg 1");
    chatRepo.send(rigId, "bob", "bob msg 1");
    chatRepo.send(rigId, "alice", "alice msg 2");

    const result = chatRepo.history(rigId, { sender: "alice" });
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.sender === "alice")).toBe(true);
  });

  it("history --since 仅返回较新的消息", () => {
    // 使用过去的时间戳，确保“现在”创建的消息都在该时间之后。
    const pastCutoff = "2020-01-01T00:00:00Z";
    chatRepo.send(rigId, "alice", "msg after cutoff");
    chatRepo.send(rigId, "bob", "also after cutoff");

    const result = chatRepo.history(rigId, { since: pastCutoff });
    expect(result).toHaveLength(2);

    // 使用未来的时间戳，确保没有消息匹配。
    const futureCutoff = "2099-01-01T00:00:00Z";
    const futureResult = chatRepo.history(rigId, { since: futureCutoff });
    expect(futureResult).toHaveLength(0);
  });

  it("组合使用 --sender 与 --after 时正常工作", () => {
    const m1 = chatRepo.send(rigId, "alice", "alice before");
    chatRepo.send(rigId, "bob", "bob after");
    chatRepo.send(rigId, "alice", "alice after");

    const result = chatRepo.history(rigId, { after: m1.id, sender: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("alice after");
  });

  it("--topic 与 --after 可在主题窗口内组合使用", () => {
    chatRepo.sendTopic(rigId, "host", "review");
    const m1 = chatRepo.send(rigId, "alice", "first review msg");
    chatRepo.send(rigId, "bob", "second review msg");

    const result = chatRepo.history(rigId, { topic: "review", after: m1.id });
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("second review msg");
  });

  it("--topic 与 --sender 可在主题窗口内组合使用", () => {
    chatRepo.send(rigId, "alice", "before topic");
    chatRepo.sendTopic(rigId, "host", "review");
    chatRepo.send(rigId, "alice", "alice review msg");
    chatRepo.send(rigId, "bob", "bob review msg");

    const result = chatRepo.history(rigId, { topic: "review", sender: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("alice review msg");
  });
});
