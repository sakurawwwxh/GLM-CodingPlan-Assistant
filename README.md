# 智谱 GLM Coding 抢购助手

Tampermonkey 脚本，自动化抢购 [bigmodel.cn](https://www.bigmodel.cn/glm-coding) GLM Coding 套餐。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展 (Chrome / Firefox / Edge)
2. 打开 Tampermonkey 控制台 → `+ 新建脚本`
3. 复制 `glm-assistant.js` 全部内容粘贴 → `Ctrl+S` 保存

## 使用步骤

1. 打开 `bigmodel.cn/glm-coding`
2. 右上角面板选择套餐: `[包月][包季][包年]` × `[Lite][Pro][Max]`
3. 设定定时时间，或直接点 `▶ 主动抢购` / 按 `Alt+S`
4. 抢到后自动拉起支付弹窗，手动完成付款

## 快捷键

| 键 | 功能 |
|----|------|
| `Alt+S` | 立即抢购 |
| `Alt+X` | 停止 |
| `Alt+H` | 隐藏/显示面板 |

## 面板配置

| 配置 | 默认值 | 说明 |
|------|--------|------|
| 并发 | 5 | 普通模式并发路数 |
| 极速 | 15 | 极速模式并发路数 (前5秒) |
| 上限 | 3000 | 最大重试次数 |
| 定时 | 10:00:00 | 每日自动抢购时间 |

## 特性

- **直接 API 请求**: 无需点按钮，直接构造 `batch-preview` → `check` 链路
- **并发重试引擎**: 前 5 秒极速爆发（15路），之后稳定并发（5路），自适应退避
- **多路竞速**: 任意一路先成功即中止其余请求
- **服务器时间同步**: 通过响应头 Date 校准北京时间，定时更精准
- **弹窗恢复**: 抢到若弹窗被吞，自动拦截 check 接口恢复支付页
- **反售罄补丁**: 拦截页面 API 响应，修正 `isSoldOut`/`isServerBusy` 状态，确保按钮可点（XHR + Vue 数据 + DOM 三层）
- **配置持久化**: 面板设置自动存 localStorage
- **Shadow DOM 面板**: 样式隔离，不干扰原页面

## v5.4 改动

- **WAF 友好**: 移除请求体随机噪声字段、固定 UA、去除随机化请求头、不再预热 PREVIEW 接口。降低被 WAF 拦截的风险
- **Vue 补丁收敛**: 只修正 `isSoldOut`/`isServerBusy`/`soldOut`，不再触碰 `disabled`/`canBuy` 等业务字段，避免套餐选择栏消失
- **preheat 修复**: 不再对 PREVIEW 发 HEAD 请求

## 已知限制

- **图片验证码**: 无法自动处理，需手动完成
- **支付**: 弹窗出现后手动扫码/付款
- **登录态**: 过期后需重新登录 bigmodel.cn
- **WAF 封 IP**: 频繁并发可能触发 IP 级别封禁，需换 IP / 等冷却

## 文件

- `glm-assistant.js` — Tampermonkey 脚本源码
- `test.js` — 单元测试

## License

MIT
