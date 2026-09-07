# LG-0 有限学习数据合同与验证原型

关联 #270。基线：main `0413176`，范围 PR #269 已合并。

状态：**候选合同 / 隔离原型，未冻结为生产合同，LG-0 未通过**。本文件不解锁 LG-1。先验证有界数据方案，记录真实性能和缺口，不改旧 A2/B1/C/D/E 门槛或产物。

## 数据候选

- 四类资产：note、bookmark、excerpt、answer。一条资产只含一个视频、可空的一个分 P，引用全部内嵌，因此不存在跨表引用孤儿。它们是内部字段，生产 UI 必须中文映射。
- ID 为 64 位小写十六进制；生产保存动作拟生成随机 256-bit ID，并在重试/重复点击时复用，不按标题或时间重新生成。合成 fixture 使用明确的确定性序号 ID。
- 所有字段必需：id、kind、createdAt、updatedAt、video、part、personal、snapshot、bookmarkMs、importedFrom。空值使用 null，不忽略字段。
- video={bvid,title}；part=null 或 {cid,page}。CID 用十进制字符串避免精度损失。时间戳/毫秒为非负安全整数，updatedAt 不早于 createdAt；page >= 1。
- personal={title,note,tags} 可编辑；video/part/snapshot/bookmarkMs 是保存时快照，不经编辑接口覆盖。标题最多 4096 UTF-16 code units，标签最多 64 个、单个最多 256 code units，无重复；正文上限仅受总容量约束。拒绝非完整 Unicode 字符串。
- note 无来源要求；bookmark 必须有精确分 P 和真实位置，但无需字幕。excerpt/answer 必须有 snapshot={origin,body,source,citations}，source={kind,hash}，每个 citation={fromMs,toMs,text}，正长度区间。引用 1–4096 条，全部属于资产自身的同一分 P。
- subtitle 摘录正文必须等于捕获原句按换行连接；summary/highlights/answer 只能保存上游已经逐条验证的完整结果（正文、类型、引用一致）。原型在预检及事务写入前重新校验当前证据提供器。生产适配器、跨页面 stale token 和真实跳转仍待 LG-2/LG-3 验证。
- 备份恢复只复原历史快照，绝不能把其中的来源摘要当作“当前已验证”。原型不发送 AI 请求、不读取视频、网络字幕或生产库。

## 容量与写入

规范 JSON 采用对象键字典序、资产按 ID 字典序、其他数组保留顺序、无空白、JSON 标准转义、不做 Unicode 归一化。逻辑字节为整个规范 assets 数组的 UTF-8 bytes，包括方括号/逗号、所有展示字段、引用及导入身份记录。数量 <= 1000 且字节 <= 10,485,760，等于可入、任意超 1 整体拒绝。

Dexie v14 原型只新增 lgAssets（主键 id）和 lgMeta（主键 key）。v13 fixture 由真实生产数据库类在 `lg0-` 专用名称下创建，并填入公开合成标记；从不打开默认 BiliAnalyticsDB 名称。每个旧表升级前后比对。固定大小的 epoch/revision 是协调信息，不是个人知识；物理 IDB/索引/缓存开销不归入 10 MiB 宣称。

预检读取一致快照，在事务外做容量/解析/哈希，写事务内比较 revision 并检查调用方 epoch。CAS 冲突最多 4 次尝试，仍冲突明确 busy，不覆盖并发结果。恢复专用接口在每次重试中重新从最新资产计算冲突合并，禁止把旧快照合并结果作为常量提交。写入只更新有界 lgAssets 表中实际新增、修改和删除的记录，绝不覆盖旧表；完整内容不变的恢复通过事务内 CAS 后不写资产、不推进 revision。清空在同一事务清表并推进 epoch，旧编辑稿不能迟到复活。普通设置重置和缓存清理未接入原型，生产保护尚待验证。

提交状态明确为短暂不可取消；AbortSignal 只覆盖提交前。模拟 abort/quota 在写入后故意抛错以检验事务回滚，**不等于真实磁盘配额或进程崩溃证据**。保存失败不修改调用方原始编辑稿。重复保存同 ID 同内容幂等：已有成功结果的确认重试是历史读取，不要求来源仍可访问，也不产生新写入；任何新资产仍必须再次核验当前来源。同 ID 不同内容拒绝。只有个人层编辑接口可更新个人字段与更新时间。

## 搜索与备份

搜索是有界线性扫描：个人标题/备注/标签、视频标题、保存正文和引用原句。查询最多 256 code units，以 NFKC + 小写标准化、空白分词、词间 AND、单词子串匹配；类型/视频精确筛选；结果仅返回稳定 ID，按 ID 排序，不承诺相关性排名。每次从当前提交状态读取，因此不维护可能失效的持久搜索索引。正文不包含全部视频字幕。

备份唯一格式是规范 UTF-8 JSON：`{"assets":[],"format":"bili-bill-learning","version":1}`。未加密，与旧 ZIP v1 无关系。文件上限为 10,485,760 + 规范空封套字节（由 MAX_FILE_BYTES 同一常量计算）；读入前检查 Blob.size。严格 UTF-8 解码、完整白名单、资产验证及规范编码相等检查，拒绝未知字段/版本、重复 JSON 键、重复 ID、额外空白和损坏文件。只接受与本工具导出相同的规范编码，不承诺接受手工改格式的 JSON；这是格式与内容一致性校验，不是外部文件来源认证或签名。写入、异步导出、解码、合并统一验证导入副本身份，不能写入或导出自己无法恢复的伪造副本。

解析前先做无对象树分配的结构资源检查，再交给原生 JSON.parse；不自建替代 JSON 解析器。既有合法 schema 最大嵌套深度为 6，单数组最多 4096 项，单对象不超过 11 个成员，数组不直接包含数组。结构容器总数上界取 `2 + 9 * MAX_ASSETS + floor(MAX_BYTES / 30)`：封套两层，每条资产最多九个非引用容器，每条引用规范编码至少 30 bytes。该保守上界不缩减合法容量；完整字段、计数、规范字节与身份检查仍保留。字符串内的结构符与转义不计作容器，importedFrom.original 的解析也受保护。此检查阻断结构膨胀输入，不等于所有恶意输入的绝对内存峰值已获证明。

恢复保留本地：ID 不存在则新增、完整内容一致则跳过。ID 冲突时以 `SHA256('lg0-import:' + incoming.id + ':' + SHA256(canonical(incoming)))` 生成副本 ID，并记录 importedFrom={id,digest,original}；original 是完整规范原始记录字符串，包含导入时的个人内容，防止伪造身份导致原始内容静默丢失。解码与合并时验证 original 的字段/规范表示、完整哈希、副本 ID 和不可变字段一致。original 内的更早导入记录只是历史快照字符串，不递归提升为新当前证据。重复导入通过副本身份识别；副本个人层后来修改也保留，原始个人内容仍在 original 中可恢复，不再制造相同副本。保留 ID 已被其他来源占用则整体拒绝，不能覆盖本地。所有副本和 original 的额外字节仍参与最终容量检查，冲突可能使原本接近上限的备份整体超限，必须明确拒绝而不是丢弃副本。生产 UI 对导入时内容的展示仍待后续切片。

## 本次固定测量设计

首次正式测量前，runner 拒绝脏工作树，并写 preflight.json：干净提交身份（sourceRevisionState=clean）、OS/CPU/内存、Node、源码文件 SHA-256、实际浏览器 bundle SHA-256、seed、容量、运行次数、度量边界。测量开始前逐项核对 Git commit blob 与绑定，CLI verifier 也核对提交与源码一致性；前两轮脏树诊断有逐文件绑定但不等同于干净提交正式证据。浏览器执行时记录 Browser.getVersion 精确版本；安装位置由显式参数指定，禁止使用任何既有用户配置目录。每个 profile 都在工作区 release-artifacts/lg0 下新建，仅包含合成 fixture，不遍历或读取 profile 文件。

6 场景：空库、30 条典型、1000 条数量边界、1000 条合计恰好 10 MiB、单条恰好 10 MiB、1000 条每条 16 个引用的中英文资产。每场景 3 个独立新 profile，播种后关闭浏览器，再重开测一次 cold；第三个 profile 接着 5 次 warm。共 48 次，失败和重跑分别保留。cold 指浏览器/连接冷重开，不宣称操作系统磁盘缓存也冷。

搜索从提交调用开始，到结果数量写入 output 后第二个 animation frame；cold 含打开库，warm 复用连接。导出、导入校验、冲突预检、原子提交分别计时。名为 atomic-commit 的阶段是完整 CAS 恢复调用（含重读、重新合并和验证），不是纯 IDB commit 时间；单独的 merge-preflight 是预检演练，不能把二者累加成本隐藏。主线程 PerformanceObserver longtask 记录 >=50ms 任务，候选最大 <=200ms；搜索候选 cold p95 <=2000ms / warm p95 <=500ms。六个场景分别判定，不用全局平均掩盖失败。

运行阶段边界采样 performance.memory.usedJSHeapSize，候选增长预算 256 MiB，**这是阶段采样高水位，不是绝对峰值或 renderer RSS，也未覆盖恶意输入峰值**。此限制意味着本轮内存证据不能直接放行 LG-0。后续需完善可取消预检/进度、实际峰值内存及故障中断测量，必要时转 Worker，不静默放宽候选。

## 运行与缺口

### 2026-09-07 新增验收工具（不自动放行）

`run-worker-formal.mjs` 使用六个既有场景、每场景三次独立浏览器冷重开与五次连续暖运行，共 48 次。冷搜索包含 Worker 和数据库打开，直到结果写入界面并经过两帧；导出、清空后的首次恢复、幂等恢复分别记录实际请求到回复的时间及进度。每次均核对完整内容摘要与规范导出字节，幂等恢复还核对 revision/epoch。播种前后的真实 v13 合成旧表保持一致，播种不纳入 UI 操作计时。

主线程 longtask 和主线程加 Worker 的 CDP 堆采样覆盖完整运行，包括额外完整性回读；请求采样间隔 25ms，保留每个样本及实际最大间隙，不强制 GC。候选仍为 cold 2000ms、warm 500ms、主线程 200ms、可取消阶段进度 2000ms、合计堆采样增长 256 MiB。该计数不是绝对峰值或 RSS，不将 Worker 内存排除。`verify-worker-report.mjs` 独立核验 48 次、每阶段和内存汇总、干净提交、源码与实际 bundle，输出候选性能结果；它不修改历史 verifier，也不单凭性能自动解锁 LG-1。

`run-worker-safety.mjs` 在单个新合成 profile 中验证运行中导入/导出取消及至少 2s 后完整状态不变；在真实 IDB bulkPut 后、元数据写入及事务提交前保持事务活动，再通过 [CDP Page.crash](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-crash) 使测试 renderer 崩溃，重开核对完整状态摘要。配额通过 [CDP Storage.overrideQuotaForOrigin](https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-overrideQuotaForOrigin) 限制本次 loopback origin，等待 [Chromium IDB 的 30 秒额度缓存](https://chromium.googlesource.com/chromium/src/+/22f9c264d938496dae83f09fe0b5bae594a90848/content/browser/indexed_db/indexed_db_bucket_context.h) 过期后进行实际写入拒绝检查，不用代码抛错代替。恢复额度后继续验证非破坏恢复、幂等与重开。

导出现在将取消信号交给编码过程，编码前后让出 Worker 消息循环，在返回 Blob 前确认取消；编码规范不变。测试专用 afterWrite 挂点只在隔离脚本显式传入时保持事务活动，不能进入生产入口。上述实验不是物理磁盘写满、整个浏览器进程崩溃或真实扩展 service worker 生命周期验收。

2026-09-07 用户已确认：LG-0 只验收隔离原型。生产升级/保存重开由 LG-1、证据适配与回看由 LG-2/LG-3、生产重置及扩展中断恢复由 LG-4 验收，LG-5 整版复验；详见范围文档第 8 节。这些职责不是 LG-0 的循环前置，也不是从发布验收中删除。256 MiB 主线程加 Worker 采样增长预算及时间目标不变，不承诺绝对峰值。现有 280 MiB 超额仍必须修复，LG-1 尚未解锁，旧失败不改判。

#### 关键复核后的测量修正

2026-09-07 内存定向修复：使用同一 formal 浏览器工作流与 heap sampler，单条 10 MiB 一次冷重开加八次连续暖运行。旧实现再次复现 260.052 MiB 超额；回归计数显示幂等恢复会编码完整资产八次，其中四次仅服务于去重和差分比较。该两处改为在已验证 JSON 上逐字段比较，保持数组次序、完整内容、冲突副本和无变化零写入语义；四次容量校验编码仍执行。只改变比较方式，未移除完整性回读、克隆或调用 GC。修复后九次定向运行最大增长 141.294 MiB，通过诊断；这是工作树快照，不替代干净提交的正式矩阵和安全验收。

`node scripts/lg0/run-worker-memory-loop.mjs` 为固定小型回归入口，明确输出 diagnostic-worker-memory-loop / formalGateStatus=not_evaluated / lg1Unlocked=false；同样只创建并清理自身合成 profile。它保留全部九次结果与实际源码/bundle 哈希，增长超过 256 MiB 或采样质量不足时非零退出，不提供挑选次数或阈值开关。

稀疏标签数组不属于合法 JSON 资产：验证逐项访问并拒绝洞对应的 undefined，比较数组时逐索引检查自有元素，不能因 every 跳过空位而漏掉修改。正式性能/安全测量绑定 8f273d7，此后中立复核的稀疏数组防护以针对性回归及短诊断验证，不能把旧 bundle 哈希冒充补丁后的 bundle。该防护不改变容量、规范备份或正常稠密资产的内容语义。

`e9c6d35` 的 48 次矩阵保留为历史候选性能记录，其取消与配额探针不计为最终安全验收：取消点过早，导出库也未达到目标容量；配额判断曾依赖错误文本。修正后导入在 Blob 读取后的同步解码阶段发出取消请求，导出库本身恰好 10 MiB，在编码阶段发出请求；Worker 处理排队取消后、任何写入或 Blob 返回前才确认。同步原生解析/编码不能在任意指令中断，只承诺本次有界负载的取消确认时间，不把预先取消冒充运行中取消。

安全 runner 现在也拒绝脏树，并在运行前由独立验证器复建绑定提交的实际 bundle；只接受错误对象及其 cause/inner 链中的精确 `QuotaExceededError` 名称，不以错误文本包含 quota 放行。另测文件上限加一、恰好文件上限的宽数组与损坏字符串，保留拒绝前后完整状态及主线程加 Worker 堆样本；这三个敌意样例不等于穷尽恶意输入。

两类新 verifier 默认只验证 HEAD；旧提交必须显式 `--historical`，结果标明历史范围且不得作为当前放行。堆采样请求间隔仍为 25ms，新增事前证据质量上限 250ms（十倍请求间隔）：实际样本间隙或单次采样耗时超过此值只可判证据不足，不判候选通过；256 MiB 预算不变。每段 committing 到 committed/重试的间隔单独汇总，缺少结束阶段则拒收，不能用提交期豁免隐藏未知时段。这些是测量完整性约束，不放宽产品门槛。

### 定向优化节奏（用户已确认）

迭代只运行相关合同回归和失败场景，方案稳定后再执行一次完整验收矩阵，不以反复跑满 48 次作为日常推进条件。数量、容量和性能候选阈值保持原值。原三轮报告作为历史证据保留，不绑定优化后的当前源码，也不改判历史失败。

新增 `node scripts/lg0/run-worker-probe.mjs`：一个全新合成 profile，三个独立数据库分别覆盖 byte-limit、single-large、references，各一次首次恢复和一次幂等恢复，共六次定向测量。记录源码/实际 bundle 哈希，若使用未提交代码则明确标记 working-tree-snapshot，不冒充正式干净提交矩阵。恢复耗时包含读取备份、解析、校验、合并、提交和返回摘要；导出/摘要哈希完整性检查不在计时区间。该流程与旧多阶段主线程演练不同，不据此计算同比提升百分比或少量样本 p95。

实验 Worker 承担导入、导出和搜索，主线程仅传 Blob 并接收进度、Blob 或小结果。提交前 prepared 阶段通过主线程确认让排队的取消请求先被处理；committing 后只报告实际提交结果，不能因为用户刚点击取消就谎报未写入。停止 Worker 则返回结果未知，重新连接后核对数据库；prepared 时终止实验不等于扩展崩溃证据。没有生产 UI 或生产数据库接入。

定向探针采样主线程与 Worker 的 CDP JS heap 并相加，同时保留两侧值和 backing storage；不做强制 GC。采样有间隙且并非同时读取，不代表绝对峰值、总进程内存或恶意输入安全上界。不能仅凭主线程内存下降宣称内存预算通过。定向结果始终 formalGateStatus=not_evaluated、lg1Unlocked=false。

`node --test tests/lg0-learning-contract.test.ts`

设置 LG0_PLAYWRIGHT_MODULE 为已有 Playwright index.mjs、LG0_CHROME_EXECUTABLE 为 Chrome stable 可执行文件，再运行 `node scripts/lg0/run-browser.mjs`。使用现有外部测试工具，不修改 package/lock。runner 仅服务固定 loopback 页面和 bundle，外部解析被阻断，所有浏览器与服务器在结束后关闭，确认实际路径位于本次运行目录后删除自建 profile。原始报告保存在工作区 release-artifacts/lg0，提交仅选公开 JSON 报告，绝不提交 profile 内容。新版源码绑定采用 UTF-8/LF 规范字节并包含报告验证器；每次正式测量保留独立 runId，不覆盖旧失败。

当前 LG-0 缺口：单条 10 MiB 连续工作流的合计堆采样增长超额，须定向修复后完成稳定候选验收。隔离原型的大负载取消、真实 renderer 事务中断、实际浏览器 quota 拒绝及三类敌意输入已有独立证据，见 benchmarks/lg0；不能提升为生产 UI、扩展生命周期或绝对内存保证。生产保护依上述用户确认职责在 LG-1 至 LG-5 验收。LG-0 尚未通过，不开始 LG-1，不宣布 0.14.0 完成。
