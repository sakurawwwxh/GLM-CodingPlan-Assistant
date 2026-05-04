# 智谱 GLM Coding 抢购助手

Tampermonkey 脚本, 自动化抢购 bigmodel.cn GLM Coding 套餐.

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展 (Chrome / Firefox / Edge)
2. 打开 Tampermonkey 控制台 → `+ 新建脚本`
3. 复制 `glm-rush-assistant.user.js` 全部内容粘贴 → 保存

## 使用步骤

1. 打开 `bigmodel.cn/glm-coding`
2. 右上角面板选择套餐: `[包月][包季✓][包年] × [Lite✓][Pro][Max]`
3. 设定定时时间 (可选)
4. 点 `▶ 主动抢购` 或按 `Alt+S`

脚本自动完成: 打开页面 → 点 tab → 点购买按钮 → 拦截请求 → 并发重试 → 成功拉起支付

## 快捷键

| 键 | 功能 |
|----|------|
| `Alt+S` | 立即抢购 |
| `Alt+X` | 停止 |
| `Alt+H` | 隐藏/显示面板 |

## 面板配置

| 配置 | 默认值 | 说明 |
|------|--------|------|
| 并发 | 5 | 普通模式并发数 |
| 极速 | 10 | 极速模式并发数 (前5秒) |
| 上限 | 2000 | 最大重试次数 |
| 定时 | 10:00:00 | 每日自动抢购时间 |

## 套餐选择

套餐类型: 包月 / 包季 / 包年
套餐规格: Lite / Pro / Max

选择后自动对应页面上的 `连续包月/连续包季/连续包年` tab 和对应套餐卡片.

## 反检测 (v5.1)

- UA 池: 9个真实浏览器 UA, 每30秒随机切换
- 请求体随机化: 加毫秒时间戳/随机串
- 批次打散: batch 内请求乱序发出
- Human-like 延迟: 50-800ms 随机间隔
- Referer / Origin: 模拟正常导航
- Accept / Cache-Control: 随机变化

## 注意事项

- **图片验证码**: 无法自动处理, 需手动完成
- **支付**: 弹窗出现后需手动完成支付
- **登录态**: 过期后需重新登录 bigmodel.cn
- **定时抢购**: 定时到点后实时构造请求, 不过期

## 文件

- `glm-assistant.js` — Tampermonkey 脚本源码
