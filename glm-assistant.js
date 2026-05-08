// ==UserScript==
// @name         智谱 GLM Coding 按钮修复 v5.7
// @namespace    http://tampermonkey.net/
// @version      5.6
// @description  仅修复售罄按钮, 不发任何请求, 不封IP
// @author       Assistant
// @match        *://www.bigmodel.cn/*
// @match        *://bigmodel.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    console.log('[GLM] v5.7 按钮修复模式已注入');

    // ═══════════════════════════════════════════
    //  patchSoldOut — 递归修正售罄标记
    // ═══════════════════════════════════════════
    function patchSoldOut(obj, visited = new WeakSet()) {
        if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
        visited.add(obj);
        if (obj.isSoldOut === true) obj.isSoldOut = false;
        if (obj.soldOut === true) obj.soldOut = false;
        if (obj.isServerBusy === true) obj.isServerBusy = false;
        if (obj.stock === 0) obj.stock = 999;
        for (const k of Object.keys(obj)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (obj[k] && typeof obj[k] === 'object') patchSoldOut(obj[k], visited);
        }
    }

    // ═══════════════════════════════════════════
    //  Fetch 拦截 — patch 响应中的售罄字段
    // ═══════════════════════════════════════════
    const _originalFetch = window.fetch;

    window.fetch = async function(input, init) {
        const resp = await _originalFetch.apply(this, arguments);
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('json')) return resp;
        try {
            const text = await resp.text();
            try {
                const data = JSON.parse(text);
                patchSoldOut(data);
                return new Response(JSON.stringify(data), {
                    status: resp.status,
                    statusText: resp.statusText,
                    headers: resp.headers,
                });
            } catch {
                return new Response(text, {
                    status: resp.status,
                    statusText: resp.statusText,
                    headers: resp.headers,
                });
            }
        } catch {
            return resp;
        }
    };
    window.fetch.toString = () => 'function fetch() { [native code] }';

    // ═══════════════════════════════════════════
    //  XHR 拦截 — 所有接口响应 patch 售罄字段
    // ═══════════════════════════════════════════
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;
    const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        (this._h || (this._h = {}))[k] = v;
        return _xhrSetHeader.call(this, k, v);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
        this._m = method; this._u = url;
        return _xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const url = this._u;
        if (typeof url !== 'string') return _xhrSend.call(this, body);

        const origReady = this.onreadystatechange;
        const origLoad = this.onload;
        const self = this;

        const patchResponse = function() {
            if (self.readyState === 4 && self.responseText) {
                try {
                    const data = JSON.parse(self.responseText);
                    patchSoldOut(data);
                    const patched = JSON.stringify(data);
                    Object.defineProperty(self, 'responseText', {
                        get: function() { return patched; },
                        configurable: true, enumerable: true,
                    });
                    Object.defineProperty(self, 'response', {
                        get: function() { return patched; },
                        configurable: true, enumerable: true,
                    });
                } catch {}
            }
        };

        this.onreadystatechange = function(e) {
            patchResponse();
            if (origReady) return origReady.call(this, e);
        };
        this.onload = function(e) {
            patchResponse();
            if (origLoad) return origLoad.call(this, e);
        };

        return _xhrSend.call(this, body);
    };

    // ═══════════════════════════════════════════
    //  持续 Vue + DOM 补丁
    // ═══════════════════════════════════════════
    function patchDOM() {
        let patched = 0;

        // 所有可能的购买按钮
        const btnSels = '.buy-btn, button[class*="buy"], button[class*="subscribe"], button';
        const buyBtns = document.querySelectorAll(btnSels);
        for (const btn of buyBtns) {
            const text = btn.textContent.trim();
            if (/特惠订阅|购买|抢购|下单/.test(text) || btn.classList.contains('buy-btn')) {
                if (btn.disabled) { btn.disabled = false; btn.classList.remove('is-disabled', 'disabled'); patched++; }
            }
            if (/售罄|补货|已抢完|暂时售罄/.test(text)) {
                btn.textContent = '特惠订阅';
                btn.disabled = false;
                btn.classList.remove('is-disabled', 'disabled');
                patched++;
            }
        }

        // 售罄遮罩/标签
        const tags = document.querySelectorAll('[class*="sold-out"], [class*="soldOut"], [class*="sold_out"], span, div');
        for (const el of tags) {
            const t = el.textContent || '';
            if (t.length < 10 && /售罄|已售|补货/.test(t) && el.children.length === 0) {
                el.style.display = 'none';
                patched++;
            }
        }

        return patched;
    }

    function patchVueData() {
        let patched = 0;
        const app = document.querySelector('#app');
        const vue = app && app.__vue__;
        if (!vue) return 0;

        const safeProps = ['isServerBusy', 'isSoldOut', 'soldOut'];
        const walk = (vm, depth) => {
            if (depth > 6) return;
            for (const prop of safeProps) {
                if (vm.$data && vm.$data[prop] === true) {
                    if (typeof vm.$set === 'function') vm.$set(vm, prop, false);
                    else vm[prop] = false;
                    patched++;
                }
                if (vm[prop] === true && !(vm.$data && vm.$data.hasOwnProperty && vm.$data.hasOwnProperty(prop))) {
                    if (typeof vm.$set === 'function') vm.$set(vm, prop, false);
                    else vm[prop] = false;
                    patched++;
                }
            }
            for (const child of (vm.$children || [])) walk(child, depth + 1);
        };
        walk(vue, 0);
        return patched;
    }

    function startPatchLoop() {
        let tick = 0;
        // 定时轮询 — 兜底
        setInterval(() => {
            tick++;
            const d = patchDOM();
            const v = patchVueData();
            if ((d + v) > 0 && tick % 60 === 0) {
                console.log(`[GLM] patch: DOM ${d} + Vue ${v} (第${tick}次)`);
            }
        }, 1000);

        // MutationObserver — 按钮一变立刻修
        new MutationObserver(() => {
            patchDOM();
            patchVueData();
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'class'] });
    }

    // ═══════════════════════════════════════════
    //  DOM ready 后启动
    // ═══════════════════════════════════════════
    function init() {
        startPatchLoop();
        console.log('[GLM] 按钮修复已启动, 持续守护中...');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
