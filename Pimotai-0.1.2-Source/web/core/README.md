# 几何核心

纯 ESM，无 DOM、Three.js、网络请求或第三方依赖。输入为非索引三角面 `Float32Array`（每面 9 个数），坐标按毫米解释且不改写。

```js
import {analyzeTriangles, suggestAlignment} from './mesh.js';
const analysis = analyzeTriangles(positions, {tolerance: 1e-4});
const proposal = suggestAlignment(piece, reference, {tolerance: .1});
```

`analyzeTriangles` 按共享的容差焊接顶点分连通部件，不推断语义零件。返回 `components`、顶层统计及同内容的 `totals`。部件包含 `triangleIndices: Uint32Array`（原输入面号）、`faces`、`validFaces`、`bounds: {min,max,size}`（三元素数组）、`closed`、`boundaryEdges`、`nonManifoldEdges`、`inconsistentEdges`、`degenerateFaces`、`orientationConsistent`、`volumeMm3`。顶层另有 `vertices`/`weldedVertices`、`totalFaces`、`closedComponents`、`tolerance`。

边只计非退化面：1 次为开放边，超过 2 次为非流形边，两次同向为绕向不一致。退化面仍保留在部件中；其最短高度不大于焊接容差时计为退化。开放、非流形、退化或绕向不一致的部件 `closed: false` 且容积为 `null`，因此总容积也为 `null`。体积计算不能检测自交、内部重叠或证明可打印性。空输入返回零统计和空部件。

默认及硬限制：分析 200 万面；焊接后默认 150 万顶点（`maxVertices` 最高 300 万）；默认 5 万部件（`maxComponents` 最高 10 万）。调用者可用 `maxFaces` 下调面数。超限、非有限坐标、错误长度及与坐标量级不相容的容差会抛出可读错误，不返回伪成功。

`suggestAlignment` 只处理**同源、同尺度、保留相同三角网格**的刚性放置；不做缩放、重网格配准或无参考语义拼装。返回 `status: 'matched'|'ambiguous'|'unmatched'`、`confidence`、`candidates`、`requiresConfirmation: true`、`searchLimited`、`reason`。候选的 `matrix` 是 **source → reference** 的 16 元素列主序刚性矩阵，可直接用于 Three.js `Matrix4.fromArray`；另有 `score`、`rmsErrorMm`、`maxErrorMm`、采样数与锚定面号。

算法选取具有稀少边长签名的源三角形，在参考中枚举刚性变换，核验最多 2048 个源顶点及 512 个面心。每个采样点都须在容差内命中参考顶点/面心；`score: 1` 仅代表这些采样通过，`confidence` 不是统计概率。一个候选为 `matched`，多个对称/重复位置为 `ambiguous`，无通过候选为 `unmatched`。即使 `matched` 也需用户目视确认；不能证明全部顶点、碰撞或装配正确。

匹配每个输入最多 20 万面；默认最多 24 个候选（`maxCandidates` 硬上限 64）、4000 次变换尝试（`maxTrials` 硬上限 2 万）、25 万次采样查询（`maxChecks` 硬上限 100 万）。遇到搜索上限时不会宣布唯一匹配。参考空间格内超过 128 个不同顶点或面心时明确拒绝，提示减小容差或简化，避免密集恶意输入形成平方复杂度。

Worker：`new Worker('./core/worker.js', {type:'module'})`；发送 `{id,type:'analyze'|'align',positions:ArrayBuffer,reference?:ArrayBuffer,options}`。可在发送时转移输入 buffer（调用方需先复制仍要保留的数据）。响应 `{id,result}` 或 `{id,error: string}`；分析的各部件面号 buffer 会转移回主线程。取消通过 `worker.terminate()` 完成；主线程应自行丢弃过期 `id` 的结果。

验证：在项目根目录执行 `node --test tests/mesh.test.mjs`。
