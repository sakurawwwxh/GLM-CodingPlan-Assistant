// ==UserScript==
// @name         智谱 GLM Coding 按钮修复 v5.6
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

    console.log('[GLM] v5.6 按钮修复模式已注入');

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
    function startPatchLoop() {
        let count = 0;
        setInterval(() => {
            count++;
            let patched = 0;

            // Vue 组件数据
            const app = document.querySelector('#app');
            const vue = app && app.__vue__;
            if (vue) {
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
            }

            // DOM 按钮
            const buyBtns = document.querySelectorAll('.buy-btn, button.buy-btn[disabled]');
            for (const btn of buyBtns) {
                if (btn.disabled) { btn.disabled = false; btn.classList.remove('is-disabled', 'disabled'); patched++; }
                if (/售罄|补货|已抢完/.test(btn.textContent || '')) {
                    btn.textContent = '特惠订阅';
                    patched++;
                }
            }

            // 售罄标签
            const soldOutTags = document.querySelectorAll('[class*="sold-out"], [class*="soldOut"]');
            for (const el of soldOutTags) {
                if (el.textContent && /售罄|已售/.test(el.textContent)) {
                    el.style.display = 'none';
                    patched++;
                }
            }

            if (patched > 0 && count % 60 === 0) {
                console.log(`[GLM] 反售罄patch: ${patched}处 (第${count}次)`);
            }
        }, 1000);
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
