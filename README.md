# 智谱 GLM Coding 按钮修复

Tampermonkey 脚本。**只做一件事——让购买按钮保持可点。** 不发请求，不自动抢，不封 IP。

## 使用教程

1. 提前打开 `bigmodel.cn/glm-coding`
2. 点击**「特惠订阅」**按钮
3. 弹出购买弹窗后，**不要刷新页面**
4. 等待 10:00（UTC+8）放货
5. 出现支付二维码后扫码购买

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，粘贴 `glm-assistant-v2-alt.js` 全部内容，保存

## 原理

JSON.parse 劫持 + Fetch 拦截 + XHR 拦截，从数据源头欺骗前端框架认为始终有货。订单/支付接口自动跳过不拦截。

## License

MIT
