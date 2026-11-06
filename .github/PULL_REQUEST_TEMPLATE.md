## 改动内容

<!-- 一句话说明这个 PR 做了什么、为什么做。 -->

## 关联 Issue

<!-- 例如 Closes #12；没有就写「无」。 -->

## 类型

- [ ] 修 bug
- [ ] 新功能
- [ ] 重构（不改变外部行为）
- [ ] 文档 / 注释
- [ ] 依赖或 CI

## 自检（提交前请全部执行）

- [ ] `pnpm --filter model-infra-kit typecheck` 0 错误
- [ ] `pnpm --filter model-infra-kit test` 全绿
- [ ] `pnpm --filter model-infra-kit build` 通过
- [ ] 看板改动：`pnpm --filter @mik/dashboard test` 全绿
- [ ] 看板改动：`pnpm --filter @mik/dashboard build` 通过

> `pnpm --filter` 的目标名请从对应包的 `package.json#name` 取，不要用目录名猜。

## 契约与硬性规则

- [ ] 未改变 `docs/interfaces.md` 的公共接口；如已改变，接口契约同步更新
- [ ] 金额仍以**整数微美元**聚合，未引入浮点求和
- [ ] 供应商差异仍走 `protocol` + `provider.meta`，未新增 `providerId === "..."` 分支
- [ ] 凭据仍只存 `api_key_ref`，日志与响应经过 `redact`
- [ ] 未读取任何第三方应用的数据目录

## 影响面

<!-- 是否影响已发布包 packages/mik 的行为或公共接口？是否需要升版？
     只影响看板/文档/测试的改动按发布闸门不升版。 -->

## 截图 / 证据

<!-- 看板或 CLI 输出改动请贴前后对比；纯逻辑改动可贴测试输出摘要。 -->
