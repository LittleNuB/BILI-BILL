import assert from "node:assert/strict";
import test from "node:test";
import { deriveWikiTopics } from "../src/shared/video-wiki-topics.ts";
import { emptyWiki, type WikiState } from "../src/shared/video-wiki.ts";
import type { LearningAsset } from "../src/shared/learning.ts";
import { stableDigestHex } from "../src/shared/stable-digest.ts";

const a = "BV0000000001";
const b = "BV0000000002";
const c = "BV0000000003";
const asset = (
  id: string,
  bvid: string,
  note: string,
  title = "标题不参与聚合",
  page = 1,
): LearningAsset => ({
  id: id.repeat(64),
  kind: "note",
  createdAt: 1,
  updatedAt: 1,
  video: { bvid, title },
  part: { cid: String(page), page },
  personal: { title: "已保存笔记", note, tags: [] },
  snapshot: null,
  bookmarkMs: null,
  importedFrom: null,
});
const state = (bvids: string[]): WikiState => ({
  ...emptyWiki(),
  pages: bvids.map((bvid) => ({ bvid, createdAt: 1, deleted: false })),
});

test("groups typical Chinese rewrites from saved bodies with a stable automatic id", () => {
  const topics = deriveWikiTopics(
    [
      asset("a", a, "上线前先检验关键流程。"),
      asset("b", b, "可靠交付需要测试关键流程。"),
    ],
    state([a, b]),
  );
  const topic = topics.find((item) => item.term === "测试");
  assert.deepEqual(topic?.bvids, [a, b]);
  assert.equal(topic?.automatic, true);
  assert.equal(topic?.id, `wiki-topic-${stableDigestHex("测试")}`);
  assert.match(topic!.id, /^wiki-topic-[a-f0-9]{64}$/);
});

test("two parts of one video cannot form an automatic topic", () => {
  const topics = deriveWikiTopics(
    [
      asset("a", a, "测试关键流程。", "第一分P", 1),
      asset("b", a, "检验关键流程。", "第二分P", 2),
    ],
    state([a]),
  );
  assert.deepEqual(topics, []);
});

test("empty saved bodies and titles alone do not create topics", () => {
  const topics = deriveWikiTopics(
    [asset("a", a, "", "测试交付"), asset("b", b, "", "检验上线")],
    state([a, b]),
  );
  assert.deepEqual(topics, []);
});

test("manual rename and include or exclude override matching while custom topics stay explicit", () => {
  const wiki = state([a, b, c]);
  wiki.topics = [
    { id: "delivery", name: "交付保障", term: "交付" },
    { id: "custom", name: "我的专题", term: null },
  ];
  wiki.relations = [
    { topicId: "delivery", bvid: a, mode: "exclude" },
    { topicId: "delivery", bvid: c, mode: "include" },
    { topicId: "custom", bvid: b, mode: "include" },
  ];
  const topics = deriveWikiTopics(
    [
      asset("a", a, "测试交付流程。"),
      asset("b", b, "检验上线流程。"),
      asset("c", c, "不相关的普通记录。"),
    ],
    wiki,
  );
  assert.deepEqual(
    topics.find((topic) => topic.id === "delivery"),
    {
      id: "delivery",
      name: "交付保障",
      term: "交付",
      bvids: [b, c],
      automatic: false,
    },
  );
  assert.deepEqual(topics.find((topic) => topic.id === "custom")?.bvids, [b]);
  assert.equal(
    topics.some((topic) => topic.automatic && topic.term === "交付"),
    false,
  );
});

test("deleted pages never participate in automatic or manual relations", () => {
  const wiki = state([a, b]);
  wiki.pages[1]!.deleted = true;
  wiki.topics = [{ id: "delivery", name: "交付", term: "交付" }];
  wiki.relations = [{ topicId: "delivery", bvid: b, mode: "include" }];
  const topics = deriveWikiTopics(
    [asset("a", a, "测试交付流程。"), asset("b", b, "检验上线流程。")],
    wiki,
  );
  assert.deepEqual(topics, [
    {
      id: "delivery",
      name: "交付",
      term: "交付",
      bvids: [a],
      automatic: false,
    },
  ]);
});
