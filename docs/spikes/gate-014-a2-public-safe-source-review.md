# GATE-014-A2 public-safe source review

Status: `insufficient_evidence`

Review date: 2026-08-18

Issue: [#262](https://github.com/LittleNuB/BiliBili-DataViz-Plugin/issues/262)

## Decision

No reviewed source currently satisfies the combined provenance, authorization,
subtitle-timeline, and sampling requirements for GATE-014-A2. This review does
not publish a calibration receipt or a derived fixture configuration. The
frozen GATE-014-A1 receipts remain unchanged.

GATE-014-C, GATE-014-D, real-workload representativeness claims, the measured
maximum segment-count tail, and final parameter freezing remain blocked. The
synthetic GATE-014-B1 result is unaffected and must not be cited as A2 evidence.

## Review boundary

The review considered public dataset cards, primary research papers, and the
official Bilibili open-platform documentation. It did not download subtitle or
video payloads and did not call a subtitle endpoint. It did not read or retain
subtitle wording, video or part identifiers, account identifiers, Cookie data,
browser profiles, login state, user history, credentials, key material, or
local paths.

A source can pass only if it supports all required aggregate measurements:

- segment-length percentiles;
- segments-per-video percentiles and the maximum measured tail;
- overlap rate and overlap-duration distribution;
- CJK, Latin, number, and punctuation proportions;
- video-duration buckets;
- sample size, sampling frame, selection method, collection date, exclusions,
  limitations, provenance, and license or explicit authorization.

Public availability by itself is not treated as permission for automated
platform-wide collection or as evidence of representative sampling.

## Candidate findings

| Candidate | Public provenance | Relevant material | Blocking finding |
| --- | --- | --- | --- |
| [ChinaOpen](https://huggingface.co/datasets/AIMClab-RUC/ChinaOpen/tree/da2a45b3f1aa5b705f4e98063f5c0874f2cccf4a) | Dataset revision `da2a45b3f1aa5b705f4e98063f5c0874f2cccf4a`; dataset card declares CC BY-NC-SA 4.0. | 1,092 Bilibili-sourced videos with manually checked titles/tags and manually written visual captions. | It does not provide native subtitle segment timelines or a subtitle-bearing sampling frame. The required segment, overlap, character-class, and maximum-tail distributions cannot be derived. |
| [OpenDialog](https://huggingface.co/datasets/k2-fsa/OpenDialog/tree/be9e48fbc34bf870417d42f1b2fe0b72eac8beff) | Dataset revision `be9e48fbc34bf870417d42f1b2fe0b72eac8beff`; dataset card declares CC BY-NC 4.0. | A large audio/text dialogue corpus containing Bilibili-derived clips. | The published unit is a processed dialogue clip, not a video-level Bilibili subtitle track. It does not preserve the sampling frame or timeline structure required for segments-per-video, overlap, video-duration, and native-subtitle representativeness. Its public keys also encode source identifiers that the A2 artifact must not retain. |
| [Verse-Bench](https://huggingface.co/datasets/dorni/Verse-Bench/tree/56201b95f1522285bdb7bcadfa3078786dfd5781) | Dataset revision `56201b95f1522285bdb7bcadfa3078786dfd5781`; the card tags Apache 2.0 while its README explicitly licenses the code. | A 295-item mixed-platform clip set with generated captions and Whisper-derived speech content followed by human checking. | The source platforms are mixed, the text is derived ASR rather than native Bilibili subtitle tracks, and the reviewed material does not establish a separate data-content license or a representative Bilibili subtitle sampling frame. |
| [BNoteHelper paper](https://doi.org/10.1145/3638775) | Primary paper describing a manually collected Bilibili note/caption corpus. | Captions corresponding to learning-video notes, sampled from selected high-profile uploaders and the authors' favorites. | The reviewed publication does not expose an authorized aggregate artifact with the required distributions. Its purposive learning-video sample cannot establish platform subtitle representativeness without additional evidence. |
| [Bilibili open platform](https://open.bilibili.com/doc) | Official API documentation and [developer service agreement](https://open.bilibili.com/agreement/developer-service), reviewed in their 2026-08-18 public form. | Approved APIs for developer applications and authorized uploader data. | No public, authorization-free subtitle-distribution API or platform-representative aggregate is documented. The agreement describes developer admission and authorized-account boundaries; this project has no reviewed written authorization for platform-wide subtitle collection. |

Open-source subtitle downloaders were not accepted as data sources. A software
license governs the downloader code and does not license the subtitle corpus,
prove the sampling frame, or authorize platform-wide collection.

## Evidence needed to resume calibration

A future source owner or authorized collector must provide a public-safe
aggregate package with no subtitle wording or source identifiers. At minimum it
must include:

1. a stable source revision or signed authorization statement, license scope,
   collection date, and responsible party;
2. a reproducible sampling frame and selection method, including subtitle
   availability filtering, content strata, language/track policy, exclusions,
   deduplication, and missing-data counts;
3. aggregate video, track, and segment counts plus the complete required
   percentile, overlap, character-class, duration-bucket, and maximum-tail
   statistics;
4. canonical serialization rules and an immutable SHA-256 for the aggregate
   package;
5. an independent privacy/provenance review confirming that no wording,
   source identifier, account identifier, or local environment detail is
   present.

Only after that package passes review may the project derive a separate
calibrated fixture configuration and bind its version/SHA-256, the accepted A2
receipt SHA-256, and the actual fixture-receipt SHA-256 in later candidate run
records.

## Rejected shortcuts

- Do not scrape public video pages or undocumented subtitle endpoints merely
  because they are reachable without a login.
- Do not use login-gated subtitles, Cookie data, browser profiles, extension
  session state, or personal watch/favorite data.
- Do not substitute generated ASR clips, visual captions, danmaku, synthetic
  fixtures, or downloader software licenses for native subtitle-distribution
  evidence.
- Do not infer a maximum segment-count tail from an average, percentile, or
  synthetic pathological fixture.
