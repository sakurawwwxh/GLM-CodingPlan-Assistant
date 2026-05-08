# 智谱 GLM Coding 抢购助手

Tampermonkey 脚本，手动抢购 [bigmodel.cn](https://www.bigmodel.cn/glm-coding) GLM Coding 套餐。

**v5.5 改为纯手动模式**，不自动发请求、不自动定时、不预热。只有你点按钮或按 Alt+S 时才抢。安全不封号。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展 (Chrome / Firefox / Edge)
2. 打开 Tampermonkey 控制台 → `+ 新建脚本`
3. 复制 `glm-assistant.js` 全部内容粘贴 → `Ctrl+S` 保存

## 使用步骤

1. 打开 `bigmodel.cn/glm-coding`，脚本自动加载
2. 右上角面板选择套餐: `[包月][包季][包年]` × `[Lite][Pro][Max]`
3. 看到按钮亮起（脚本自动修正售罄状态），点 `▶ 手动抢购` 或按 `Alt+S`
4. 验证码出来手动填，抢到后自动拉起支付弹窗

> 脚本不会自动发请求。你不点按钮它什么也不做。

## 快捷键

| 键 | 功能 |
|----|------|
| `Alt+S` | 手动抢购 |
| `Alt+X` | 停止 |
| `Alt+H` | 隐藏/显示面板 |

## 面板配置

| 配置 | 默认值 | 说明 |
|------|--------|------|
| 并发 | 5 | 普通模式并发路数 |
| 极速 | 15 | 极速模式并发路数 (前5秒) |
| 上限 | 3000 | 最大重试次数 |

## 特性

- **纯手动触发**: 无定时、无自动预热、无自动调度。不点按钮不发请求
- **直接 API 请求**: 无需点页面按钮，直接构造 `batch-preview` → `check` 链路
- **并发重试引擎**: 前 5 秒极速爆发（15路），之后稳定并发（5路），自适应退避
- **多路竞速**: 任意一路先成功即中止其余请求
- **弹窗恢复**: 抢到若弹窗被吞，自动拦截 check 接口恢复支付页
- **反售罄补丁**: XHR + Vue + DOM 三层修正 `isSoldOut`/`isServerBusy`，按钮保持可点
- **WAF 友好**: 固定 UA、固定请求头、无参数篡改
- **配置持久化**: 面板设置自动存 localStorage
- **Shadow DOM 面板**: 样式隔离，不干扰原页面

## 已知限制

- **图片验证码**: 无法自动处理，需手动完成
- **支付**: 弹窗出现后手动扫码/付款
- **登录态**: 过期后需重新登录 bigmodel.cn

## 文件

- `glm-assistant.js` — Tampermonkey 脚本源码
- `test.js` — 单元测试

## License

MIT
