import type { LearningAsset } from "./learning.ts";
import { stableDigestHex } from "./stable-digest.ts";
import {
  WIKI_MAX_TOPICS,
  type WikiState,
  type WikiViewTopic,
} from "./video-wiki.ts";

const TERMS_PER_VIDEO = 6;
const stop = new Set([
  "这个",
  "那个",
  "如何",
  "什么",
  "怎么",
  "可以",
  "需要",
  "我们",
  "你们",
  "一下",
  "为什么",
  "哪些",
  "视频",
  "笔记",
  "内容",
  "相关",
  "进行",
  "通过",
  "已经",
  "一个",
  "没有",
]);
const equivalents = [
  ["测试", "检验", "验证"],
  ["需求", "要求"],
  ["稳定", "可靠"],
  ["交付", "上线"],
  ["上下文", "语境"],
];

function canonicalTerm(value: string): string {
  const term = value.normalize("NFKC").trim().toLowerCase();
  return equivalents.find((group) => group.includes(term))?.[0] ?? term;
}

function terms(text: string): string[] {
  const words = [
    ...new Intl.Segmenter("zh", { granularity: "word" }).segment(
      text.normalize("NFKC").toLowerCase(),
    ),
  ]
    .filter((part) => part.isWordLike && part.segment.length > 1)
    .map((part) => canonicalTerm(part.segment))
    .filter((term) => term.length <= 80 && !stop.has(term));
  return words;
}

function savedText(asset: LearningAsset): string {
  return [asset.personal.note, asset.snapshot?.body ?? ""]
    .filter(Boolean)
    .join("\n");
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function deriveWikiTopics(
  assets: LearningAsset[],
  state: WikiState,
): WikiViewTopic[] {
  const activeBvids = new Set(
    state.pages.filter((page) => !page.deleted).map((page) => page.bvid),
  );
  const videoTerms = new Map<string, Map<string, number>>();
  for (const asset of assets) {
    if (!activeBvids.has(asset.video.bvid)) continue;
    const text = savedText(asset);
    if (!text.trim()) continue;
    const counts =
      videoTerms.get(asset.video.bvid) ?? new Map<string, number>();
    for (const term of terms(text))
      counts.set(term, (counts.get(term) ?? 0) + 1);
    if (counts.size) videoTerms.set(asset.video.bvid, counts);
  }

  const support = new Map<string, number>();
  for (const counts of videoTerms.values())
    for (const term of counts.keys())
      support.set(term, (support.get(term) ?? 0) + 1);

  const automaticMembers = new Map<string, Set<string>>();
  for (const [bvid, counts] of videoTerms) {
    const selected = [...counts]
      .filter(([term]) => (support.get(term) ?? 0) >= 2)
      .sort(([left, leftCount], [right, rightCount]) => {
        const score = (term: string, count: number) =>
          count * 4 +
          term.length * 2 +
          Math.log((activeBvids.size + 1) / ((support.get(term) ?? 0) + 1));
        return (
          score(right, rightCount) - score(left, leftCount) ||
          left.localeCompare(right)
        );
      })
      .slice(0, TERMS_PER_VIDEO);
    for (const [term] of selected) {
      const members = automaticMembers.get(term) ?? new Set<string>();
      members.add(bvid);
      automaticMembers.set(term, members);
    }
  }

  const relations = new Map(
    state.relations.map((relation) => [
      `${relation.topicId}:${relation.bvid}`,
      relation.mode,
    ]),
  );
  const manualTerms = new Set(
    state.topics.flatMap((topic) =>
      topic.term === null ? [] : [canonicalTerm(topic.term)],
    ),
  );
  const manual = state.topics.map((topic) => {
    const matching =
      topic.term === null
        ? new Set<string>()
        : new Set(
            [...videoTerms]
              .filter(([, counts]) => counts.has(canonicalTerm(topic.term!)))
              .map(([bvid]) => bvid),
          );
    for (const bvid of activeBvids) {
      const mode = relations.get(`${topic.id}:${bvid}`);
      if (mode === "include") matching.add(bvid);
      if (mode === "exclude") matching.delete(bvid);
    }
    return { ...topic, bvids: sorted(matching), automatic: false };
  });

  const automatic = [...automaticMembers]
    .filter(([term, bvids]) => bvids.size >= 2 && !manualTerms.has(term))
    .sort(
      ([left, leftBvids], [right, rightBvids]) =>
        rightBvids.size - leftBvids.size || left.localeCompare(right),
    )
    .slice(0, WIKI_MAX_TOPICS)
    .map(([term, bvids]) => ({
      id: `wiki-topic-${stableDigestHex(term)}`,
      name: term,
      term,
      bvids: sorted(bvids),
      automatic: true,
    }));
  return [...manual, ...automatic];
}
