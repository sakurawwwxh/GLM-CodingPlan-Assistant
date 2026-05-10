// ==UserScript==
// @name         智谱 GLM Coding 终极抢购助手 (数据拦截版)
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  在底层拦截并篡改服务器返回的数据流，让前端框架彻底认为有货，从而原生激活按钮和完整的支付逻辑。
// @author       YourName
// @match        *://www.bigmodel.cn/*
// @match        *://bigmodel.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    console.log('[抢购助手2.1] 网络拦截器已在页面最早期启动...');

    // 订单/支付接口不拦截，避免空订单
    const SKIP_PATTERNS = ['/api/biz/pay/', '/api/biz/order/'];
    function shouldSkip(url) {
        if (typeof url !== 'string') return true;
        return SKIP_PATTERNS.some(p => url.includes(p));
    }

    // ==========================================
    // 战术一：拦截 JSON.parse
    // ==========================================
    const originalJSONParse = JSON.parse;
    JSON.parse = function(text, reviver) {
        let result = originalJSONParse(text, reviver);
        function deepModify(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.isSoldOut === true) obj.isSoldOut = false;
            if (obj.soldOut === true) obj.soldOut = false;
            if (obj.stock === 0) obj.stock = 999;
            for (let key in obj) {
                if (obj[key] && typeof obj[key] === 'object') deepModify(obj[key]);
            }
        }
        try { deepModify(result); } catch (e) {}
        return result;
    };

    // ==========================================
    // 战术二：拦截 Fetch
    // ==========================================
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url || '');
        if (shouldSkip(url)) return response;

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const clone = response.clone();
            try {
                let text = await clone.text();
                if (text.includes('"isSoldOut":true') || text.includes('"soldOut":true')) {
                    console.log('[抢购助手] 拦截 Fetch 售罄数据，篡改中...', url);
                    text = text.replace(/"isSoldOut":true/g, '"isSoldOut":false')
                               .replace(/"soldOut":true/g, '"soldOut":false')
                               .replace(/"stock":0/g, '"stock":999');
                    return new Response(text, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                }
            } catch (e) {}
        }
        return response;
    };

    // ==========================================
    // 战术三：拦截 XHR
    // ==========================================
    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._reqUrl = url;
        return origXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(...args) {
        const url = this._reqUrl;
        const self = this;
        if (shouldSkip(url)) return origXHRSend.apply(this, args);

        const origReady = this.onreadystatechange;
        const origLoad = this.onload;

        this.onreadystatechange = function(e) {
            if (self.readyState === 4 && self.status === 200 && self.responseText) {
                try {
                    let text = self.responseText;
                    if (text.includes('"isSoldOut":true') || text.includes('"soldOut":true')) {
                        console.log('[抢购助手] 拦截 XHR 售罄数据，篡改中...', url);
                        text = text.replace(/"isSoldOut":true/g, '"isSoldOut":false')
                                   .replace(/"soldOut":true/g, '"soldOut":false')
                                   .replace(/"stock":0/g, '"stock":999');
                        Object.defineProperty(self, 'responseText', {
                            get: function() { return text; },
                            configurable: true, enumerable: true
                        });
                        Object.defineProperty(self, 'response', {
                            get: function() { return text; },
                            configurable: true, enumerable: true
                        });
                    }
                } catch (e) {}
            }
            if (origReady) return origReady.call(this, e);
        };

        this.onload = function(e) {
            if (self.readyState === 4 && self.status === 200 && self.responseText) {
                try {
                    let text = self.responseText;
                    if (text.includes('"isSoldOut":true') || text.includes('"soldOut":true')) {
                        text = text.replace(/"isSoldOut":true/g, '"isSoldOut":false')
                                   .replace(/"soldOut":true/g, '"soldOut":false')
                                   .replace(/"stock":0/g, '"stock":999');
                        Object.defineProperty(self, 'responseText', {
                            get: function() { return text; },
                            configurable: true, enumerable: true
                        });
                        Object.defineProperty(self, 'response', {
                            get: function() { return text; },
                            configurable: true, enumerable: true
                        });
                    }
                } catch (e) {}
            }
            if (origLoad) return origLoad.call(this, e);
        };

        return origXHRSend.apply(this, args);
    };

})();
