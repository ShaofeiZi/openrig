# L0——解析主机侧构建输入（每次构建的前置条件）

**在主机侧运行。** 填充构建命令在解析前会拒绝使用的两个已记录槽位，使镜像能够基于固定的基础镜像和已知的 stub 资源清单实现逐字节复现。每当基础镜像或 stub 资源发生变化时执行一次；提交解析后的槽位，使固定结果可以持久保留。

## L0.1——解析固定摘要的基础镜像

VM 席位无法拉取或检查 registry digest；请在装有容器运行时的主机上完成此操作。

```bash
# Pull the intended LTS-slim base, then read its immutable RepoDigest.
docker pull debian:bookworm-slim
BASE_REF="$(docker inspect --format '{{index .RepoDigests 0}}' debian:bookworm-slim)"
echo "${BASE_REF}"          # e.g. debian@sha256:<64-hex>  (or docker.io/library/debian@sha256:...)
```

将解析出的唯一引用写入槽位，替换原注释块：

```bash
printf '%s\n' "${BASE_REF}" > docker/testbed/base-image
# Prove the fence accepts it (readBaseImage returns the digest, or exits non-zero):
node -e 'import("./scripts/testbed-build-inputs.mjs").then(m=>console.log(m.readBaseImage("docker/testbed/base-image")))'
```

**PASS：** `readBaseImage` 输出 `{ ref, name, digest: 'sha256:<64-hex>' }`。**FAIL：** 命令以非零状态退出，或报告 `tag-floating` / `unresolved`——该槽位不是有效的 digest pin，不得继续构建。

## L0.2——最终确定 stub-assets 清单

零 token 的 stub 载荷（计划 §1 第 4 层）包括容器内的 stub `rig.yaml`、其 agent fixture，以及由 L3 启动的 `culture.md`。将每个仓库相对路径逐行加入 `docker/testbed/stub-assets.list`，注释和空行会被忽略。根据 L3 实际稳定运行的 `zrig up` stub 拓扑确定精确集合，不要猜测；该列表就是 manifest 计算哈希时使用的清单范围。

```bash
# After populating the list, prove the census resolves over the staged set the build will stage:
node -e 'import("./scripts/testbed-build-inputs.mjs").then(m=>{
  const fs=require("fs");
  const files=fs.readFileSync("docker/testbed/stub-assets.list","utf8").split("\n").map(s=>s.replace(/#.*/,"").trim()).filter(Boolean);
  console.log(m.deriveStubAssetsHash(".", files).receipt);
})'
```

**PASS：** 回执准确列出预期的 stub 资源，每项都带有 64 位十六进制内容摘要。**FAIL：** 集合为空、文件缺失或路径逸出根目录——修正列表，绝不接受不完整清单。

## L0.3——记录证据

```bash
GIT_SHA="$(git rev-parse HEAD)"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
{ echo "docker: $(docker --version)"; echo "base: ${BASE_REF}"; echo "stub-assets.list:"; cat docker/testbed/stub-assets.list; } > "${EVID}/L0-inputs.txt"
echo "VERDICT: PASS — base digest pinned + stub census resolved" >> "${EVID}/L0-inputs.txt"
```
