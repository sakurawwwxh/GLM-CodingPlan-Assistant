# 智谱 GLM Coding 按钮修复

Tampermonkey 脚本。**只做一件事——让购买按钮保持可点。** 不发请求，不自动抢，不封 IP。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，粘贴 `glm-assistant.js` 全部内容，保存

## 效果

- 打开 `bigmodel.cn/glm-coding`
- 按钮始终显示"特惠订阅"而不是"暂时售罄"
- 10 点到了直接点按钮，不用刷新页面
- **脚本不发任何网络请求**，抢购完全手动

## 原理

XHR 响应拦截 + Vue 数据修正 + DOM 按钮修复，三层补丁持续运行。

## License

MIT
