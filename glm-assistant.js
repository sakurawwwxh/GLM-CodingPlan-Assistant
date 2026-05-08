// ==UserScript==
// @name         智谱 GLM Coding 抢购助手 v5.5
// @namespace    http://tampermonkey.net/
// @version      5.5
// @description  手动抢购(v5.5) + 反售罄补丁 + 弹窗恢复 + 配置持久化 (无自动定时, 安全不封号)
// @author       Assistant
// @match        *://www.bigmodel.cn/*
// @match        *://bigmodel.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════
    //  配置 (localStorage 持久化)
    // ═══════════════════════════════════════════
    const DEFAULT_CFG = {
        concurrency: 5,
        turboConcurrency: 15,
        turboSec: 5,
        maxRetry: 3000,
        burstCount: 40,
        fastDelay: 15,
        slowDelay: 50,
        jitter: 0.2,
        recoveryMax: 3,
        logMax: 100,
        PREVIEW: '/api/biz/pay/batch-preview',
        CHECK: '/api/biz/pay/check',
        packageType: 'quarterly',
        packageTier: 'lite',
    };

    function loadCfg() {
        try {
            const saved = JSON.parse(localStorage.getItem('glm_rush_cfg'));
            return { ...DEFAULT_CFG, ...saved };
        } catch { return { ...DEFAULT_CFG }; }
    }
    function saveCfg(cfg) {
        const { PREVIEW, CHECK, ...save } = cfg;
        localStorage.setItem('glm_rush_cfg', JSON.stringify(save));
    }

    const CFG = loadCfg();

    // ═══════════════════════════════════════════
    //  状态
    // ═══════════════════════════════════════════
    let state = {
        status: 'idle',
        count: 0,
        bizId: null,
        captured: null,
        cache: null,
        lastSuccess: null,
        proactive: false,
        logs: [],
        stats: { total: 0, success: 0, errors: 0, avgMs: 0, startTime: 0 },
    };

    function setState(patch) {
        state = { ...state, ...patch };
        refreshUI();
    }

    try {
        const saved = sessionStorage.getItem('glm_rush_captured');
        if (saved) state.captured = JSON.parse(saved);
    } catch {}

    let stopRequested = false;
    let recovering = false;
    let recoveryAttempts = 0;
    let _shadowRef = null;

    // ═══════════════════════════════════════════
    //  工具
    // ═══════════════════════════════════════════
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const jitteredDelay = base => Math.round(base * (1 + (Math.random() * 2 - 1) * CFG.jitter));

    function getDelay(attempt) {
        if (attempt <= CFG.burstCount) return 0;
        if (attempt <= 50) return jitteredDelay(CFG.fastDelay);
        return jitteredDelay(CFG.slowDelay);
    }

    function log(msg, level = 'info') {
        const entry = { ts: ts(), msg, level };
        const logs = [...state.logs, entry];
        if (logs.length > CFG.logMax) logs.splice(0, logs.length - CFG.logMax);
        state = { ...state, logs };
        console.log(`[GLM] ${msg}`);
        appendLogDOM(entry);
    }

    function extractHeaders(h) {
        const o = {};
        if (!h) return o;
        if (h instanceof Headers) h.forEach((v, k) => (o[k] = v));
        else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k] = v));
        else Object.entries(h).forEach(([k, v]) => (o[k] = v));
        return o;
    }

    // ═══════════════════════════════════════════
    //  UA - 固定, 不换
    // ═══════════════════════════════════════════
    const UA_POOL = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    ];
    const _currentUA = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

    function getUA() {
        return _currentUA;
    }

    // ═══════════════════════════════════════════
    //  人-like 延迟
    // ═══════════════════════════════════════════
    function humanLikeDelay() {
        if (Math.random() < 0.8) {
            return 20 + Math.random() * 80;
        }
        return 100 + Math.random() * 200;
    }

    async function fireWithScatter(promises) {
        const indices = promises.map((_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        const results = new Array(promises.length);
        await Promise.all(indices.map(async (idx, offset) => {
            const delay = Math.min(humanLikeDelay(), 100) * Math.min(offset, 2);
            await sleep(delay);
            try {
                results[idx] = await promises[idx];
            } catch (e) {
                results[idx] = { ok: false, reason: `网络: ${e.message}`, attempt: 0 };
            }
        }));
        return results;
    }

    function scrambleBody(body) {
        return body;
    }

    // ═══════════════════════════════════════════
    //  API 响应 patch — 修正售罄标记
    // ═══════════════════════════════════════════
    const _parse = JSON.parse;

    function safeParseWithPatch(text, reviver) {
        const result = _parse(text, reviver);
        try { patchSoldOut(result); } catch {}
        return result;
    }

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
    //  并发重试引擎 (手动触发)
    // ═══════════════════════════════════════════
    const _fetch = window.fetch;
    let _retryChain = Promise.resolve();

    async function singleAttempt(url, opts, attemptNum) {
        try {
            const reqHeaders = { ...opts.headers };
            reqHeaders['User-Agent'] = _currentUA;
            reqHeaders['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.7';
            reqHeaders['Referer'] = `${location.origin}/glm-coding`;
            reqHeaders['Origin'] = location.origin;
            reqHeaders['Accept'] = 'application/json, text/plain, */*';

            let body = opts.body;
            if (opts.method === 'POST' && body) {
                body = scrambleBody(body);
            }

            const resp = await _fetch(url, { ...opts, body, headers: reqHeaders, credentials: 'include' });

            if (resp.status === 401 || resp.status === 403) {
                return { ok: false, reason: `HTTP ${resp.status} 会话过期`, attempt: attemptNum };
            }
            if (resp.status === 429) {
                return { ok: false, reason: '429 限流', attempt: attemptNum };
            }

            const text = await resp.text();
            let data;
            try { data = safeParseWithPatch(text); } catch { data = null; }

            if (data && data.code === 200 && data.data && data.data.bizId) {
                const bizId = data.data.bizId;
                try {
                    const checkUrl = `${location.origin}${CFG.CHECK}?bizId=${encodeURIComponent(bizId)}`;
                    const checkResp = await _fetch(checkUrl, { credentials: 'include' });
                    const checkText = await checkResp.text();
                    let checkData;
                    try { checkData = _parse(checkText); } catch { checkData = null; }
                    if (checkData && checkData.data === 'EXPIRE') {
                        return { ok: false, reason: 'EXPIRE', attempt: attemptNum };
                    }
                    return { ok: true, text, data, bizId, status: resp.status, attempt: attemptNum };
                } catch (e) {
                    return { ok: false, reason: `check异常: ${e.message}`, attempt: attemptNum };
                }
            }

            const reason = !data ? '非JSON'
                : data.code === 555 ? '系统繁忙'
                : (data.data && data.data.bizId === null) ? '售罄'
                : `code=${data.code}`;
            return { ok: false, reason, attempt: attemptNum };
        } catch (e) {
            if (e.name === 'AbortError') return { ok: false, reason: '已取消', attempt: attemptNum };
            return { ok: false, reason: `网络: ${e.message}`, attempt: attemptNum };
        }
    }

    async function retry(url, rawOpts) {
        _retryChain = _retryChain.then(async () => {
            if (stopRequested) return { ok: false };

            setState({ status: 'retrying', count: 0, stats: { ...state.stats, startTime: performance.now() } });

            if (state.count === 0) {
                await sleep(50 + Math.random() * 250);
            }

            let totalAttempt = 0;
            let consecutiveErrors = 0;
            let throttleCount = 0;
            let consecutiveSoldOut = 0;

            while (totalAttempt < CFG.maxRetry && !stopRequested) {
                const elapsedMs = performance.now() - state.stats.startTime;
                const isTurbo = elapsedMs < CFG.turboSec * 1000;
                const curConcurrency = isTurbo ? CFG.turboConcurrency : CFG.concurrency;
                const batchSize = Math.min(curConcurrency, CFG.maxRetry - totalAttempt);
                const controllers = [];
                const promises = [];

                for (let j = 0; j < batchSize; j++) {
                    totalAttempt++;
                    const ac = new AbortController();
                    controllers.push(ac);
                    promises.push(
                        singleAttempt(url, { ...rawOpts, signal: ac.signal }, totalAttempt)
                    );
                }

                setState({ count: totalAttempt });

                const winner = await new Promise(resolve => {
                    let settled = false;
                    let doneCount = 0;
                    promises.forEach((p, idx) => {
                        p.then(r => {
                            if (r.ok && !settled) {
                                settled = true;
                                controllers.forEach((ac, i) => { if (i !== idx) try { ac.abort(); } catch {} });
                                resolve(r);
                            }
                            if (++doneCount === promises.length && !settled) resolve(null);
                        });
                    });
                });

                const results = await fireWithScatter(promises);

                if (winner) {
                    setState({
                        status: 'success',
                        bizId: winner.bizId,
                        lastSuccess: { text: winner.text, data: winner.data },
                        stats: { ...state.stats, total: totalAttempt, success: state.stats.success + 1 },
                    });
                    log(`成功! bizId=${winner.bizId} (第${winner.attempt}次)`);
                    recoveryAttempts = 0;
                    setTimeout(autoRecover, 500);
                    return { ok: true, text: winner.text, data: winner.data, status: winner.status };
                }

                const failedResults = results.filter(r => !r.ok);
                const reasons = failedResults.map(r => r.reason || '未知');
                setState({ stats: { ...state.stats, errors: state.stats.errors + failedResults.length } });

                const networkErrors = reasons.filter(r => r.startsWith('网络')).length;
                consecutiveErrors = networkErrors === batchSize ? consecutiveErrors + 1 : 0;

                if (consecutiveErrors >= 3) {
                    log('网络异常, 暂停3秒...');
                    await sleep(3000);
                    consecutiveErrors = 0;
                }

                if (reasons.some(r => r.includes('会话过期'))) {
                    log('会话已过期, 请重新登录!', 'error');
                    setState({ status: 'failed' });
                    return { ok: false };
                }

                if (reasons.some(r => r.includes('429') || r.includes('限流'))) {
                    throttleCount++;
                    const backoff = Math.min(2000 * (2 ** Math.min(throttleCount, 4)), 16000);
                    log(`限流, 退避${backoff}ms...`, 'warn');
                    await sleep(backoff);
                } else {
                    throttleCount = 0;
                }

                if (reasons.every(r => r === 'EXPIRE')) continue;

                const elapsedSec = (performance.now() - state.stats.startTime) / 1000;

                if (elapsedSec > 20) {
                    const soldOutCount = reasons.filter(r => r === '售罄').length;
                    if (soldOutCount === batchSize) {
                        consecutiveSoldOut++;
                    } else {
                        consecutiveSoldOut = 0;
                    }
                    if (consecutiveSoldOut >= 10) {
                        if (consecutiveSoldOut === 10) log('连续售罄, 可能已抢完, 降速 (2s)...');
                        await sleep(2000);
                        continue;
                    }
                }

                if (totalAttempt <= 5 * CFG.concurrency || totalAttempt % (20 * CFG.concurrency) === 0) {
                    const sec = elapsedSec.toFixed(0);
                    log(`#${totalAttempt} ${reasons[0]} (${sec}s)`);
                }

                const d = getDelay(totalAttempt / CFG.concurrency);
                if (d > 0) await sleep(d);
            }

            if (!stopRequested) {
                setState({ status: 'failed' });
                log(`达到上限 ${CFG.maxRetry} 次`);
            } else {
                setState({ status: 'idle' });
            }
            return { ok: false };
        });

        return _retryChain;
    }

    // ═══════════════════════════════════════════
    //  Fetch 拦截 — 只捕获请求, 不自动调度
    // ═══════════════════════════════════════════
    const _originalFetch = window.fetch;

    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input?.url;

        if (url && url.includes(CFG.PREVIEW)) {
            const captured = {
                url,
                method: init?.method || 'POST',
                body: init?.body,
                headers: extractHeaders(init?.headers),
            };
            setState({ captured });
            try { sessionStorage.setItem('glm_rush_captured', JSON.stringify(captured)); } catch {}
            log(`[捕获请求] ${captured.method} body=${typeof captured.body === 'string' ? captured.body.substring(0, 200) : captured.body}`);

            if (state.status === 'success' && state.lastSuccess) {
                log('已抢到, 返回成功响应');
                return new Response(state.lastSuccess.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            if (state.cache) {
                log('返回缓存响应');
                const c = state.cache;
                setState({ cache: null });
                recoveryAttempts = 0;
                return new Response(c.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            if (state.proactive || state.status === 'retrying') {
                log('抢购中, 启动重试...');
                const result = await retry(url, {
                    method: init?.method || 'POST',
                    body: init?.body,
                    headers: extractHeaders(init?.headers),
                });
                if (result.ok) {
                    return new Response(result.text, { status: result.status, headers: { 'Content-Type': 'application/json' } });
                }
                return _originalFetch.apply(this, [input, init]);
            }

            // 不做自动调度, 直接放行
            return _originalFetch.apply(this, [input, init]);
        }

        if (url && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            log('拦截 check(bizId=null)');
            return new Response('{"code":-1,"msg":"等待有效bizId"}', {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }

        return _originalFetch.apply(this, [input, init]);
    };
    window.fetch.toString = () => 'function fetch() { [native code] }';

    // ═══════════════════════════════════════════
    //  XHR 拦截 — 反售罄 + 请求捕获
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

        // 非抢购 API: 拦截响应, patch 售罄标记
        if (typeof url === 'string' && !url.includes(CFG.PREVIEW) && !url.includes(CFG.CHECK)) {
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
        }

        if (typeof url === 'string' && url.includes(CFG.PREVIEW)) {
            const self = this;
            const captured = { url, method: this._m, body, headers: this._h || {} };
            setState({ captured });
            try { sessionStorage.setItem('glm_rush_captured', JSON.stringify(captured)); } catch {}
            log(`[捕获请求-XHR] ${captured.method} body=${typeof captured.body === 'string' ? captured.body.substring(0, 200) : captured.body}`);

            if (state.status === 'success' && state.lastSuccess) {
                log('已抢到, 返回成功响应 (XHR)');
                fakeXHR(self, state.lastSuccess.text);
                return;
            }

            if (state.cache) {
                log('返回缓存响应 (XHR)');
                const c = state.cache; setState({ cache: null });
                recoveryAttempts = 0;
                fakeXHR(self, c.text);
                return;
            }

            if (state.proactive || state.status === 'retrying') {
                log('抢购中, 启动重试 (XHR)...');
                const extraHeaders = {
                    'User-Agent': _currentUA,
                    'Referer': `${location.origin}/glm-coding`,
                    'Origin': location.origin,
                    'Accept': 'application/json, text/plain, */*',
                };
                const mergedHeaders = { ...(this._h || {}), ...extraHeaders };
                retry(url, { method: this._m, body, headers: mergedHeaders }).then(result => {
                    fakeXHR(self, result.ok ? result.text : '{"code":-1,"msg":"重试失败"}');
                });
                return;
            }

            // 不做自动调度, 直接放行
            return _xhrSend.call(this, body);
        }

        if (typeof url === 'string' && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            fakeXHR(this, '{"code":-1,"msg":"等待有效bizId"}');
            return;
        }

        return _xhrSend.call(this, body);
    };

    function fakeXHR(xhr, text) {
        setTimeout(() => {
            const dp = (k, v) => Object.defineProperty(xhr, k, { value: v, configurable: true });
            dp('readyState', 4); dp('status', 200); dp('statusText', 'OK');
            dp('responseText', text); dp('response', text);
            const ev = new Event('readystatechange');
            if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange(ev);
            xhr.dispatchEvent(ev);
            const ld = new ProgressEvent('load');
            if (typeof xhr.onload === 'function') xhr.onload(ld);
            xhr.dispatchEvent(ld);
            xhr.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
    }

    // ═══════════════════════════════════════════
    //  请求构造
    // ═══════════════════════════════════════════
    const TAB_MAP = {
        monthly: '连续包月',
        quarterly: '连续包季',
        yearly: '连续包年',
    };

    const TIER_MAP = {
        lite: 'Lite',
        pro: 'Pro',
        max: 'Max',
    };

    async function autoGrab() {
        log(`手动抢购: ${TAB_MAP[CFG.packageType]} + ${TIER_MAP[CFG.packageTier]}`);

        const url = `${location.origin}${CFG.PREVIEW}`;
        const body = JSON.stringify({ invitationCode: "" });
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'Referer': `${location.origin}/glm-coding`,
            'Origin': location.origin,
        };

        log(`构造请求: ${url}`);
        setState({ captured: { url, method: 'POST', body, headers } });

        return { url, method: 'POST', body, headers };
    }

    // ═══════════════════════════════════════════
    //  弹窗恢复
    // ═══════════════════════════════════════════
    function findErrorDialog() {
        const sels = [
            '.el-dialog', '.el-message-box', '.el-dialog__wrapper',
            '.ant-modal', '.ant-modal-wrap',
            '[class*="modal"]', '[class*="dialog"]', '[class*="popup"]', '[role="dialog"]',
        ];
        for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) {
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
                if (!el.offsetParent && s.position !== 'fixed') continue;
                if (/购买人数过多|系统繁忙|稍后再试|请重试|繁忙|失败|出错|异常/.test(el.textContent || '')) return el;
            }
        }
        return null;
    }

    function dismissDialog(dialog) {
        for (const sel of ['.el-dialog__headerbtn', '.el-message-box__headerbtn', '.ant-modal-close', '[aria-label="Close"]', '[aria-label="close"]']) {
            const btn = dialog.querySelector(sel);
            if (btn && btn.offsetParent !== null) { btn.click(); return true; }
        }
        for (const btn of dialog.querySelectorAll('button, [role="button"]')) {
            const t = (btn.textContent || '').trim();
            if (/关闭|确定|取消|知道了|OK|Cancel|Close|确认/.test(t) && t.length < 10) { btn.click(); return true; }
        }
        dialog.style.display = 'none';
        return true;
    }

    async function autoRecover() {
        if (recovering || recoveryAttempts >= CFG.recoveryMax || !state.lastSuccess) return;
        recovering = true;
        recoveryAttempts++;

        try {
            const payEl = document.querySelector('[class*="pay"], [class*="qrcode"], [class*="wechat"], [class*="alipay"], [class*="cashier"], iframe[src*="pay"]');
            if (payEl && (payEl.offsetParent !== null || window.getComputedStyle(payEl).position === 'fixed')) {
                log('支付弹窗已出现, 跳过恢复');
                return;
            }

            const dialog = findErrorDialog();
            if (!dialog) return;

            log('检测到错误弹窗, 清理中...');
            dismissDialog(dialog);
            await sleep(300);

            setState({ cache: state.lastSuccess });
            const btn = findBuyButton();
            if (btn) {
                btn.click();
                log('已重新点击购买按钮');
                await sleep(2000);
            }

            const payDialog = document.querySelector('[class*="pay"], [class*="qrcode"], [class*="wechat"], [class*="alipay"]');
            if (!payDialog || payDialog.offsetParent === null) {
                const bizId = state.bizId;
                if (bizId) {
                    log('支付弹窗未出现, 尝试直接调用 check...');
                    try {
                        const checkUrl = `${location.origin}${CFG.CHECK}?bizId=${encodeURIComponent(bizId)}`;
                        const resp = await _originalFetch(checkUrl, { credentials: 'include' });
                        const data = await resp.json();
                        log('check响应: ' + JSON.stringify(data).substring(0, 200));

                        if (data.data && typeof data.data === 'string' && data.data.startsWith('http')) {
                            log('获取到支付链接, 跳转中...');
                            window.open(data.data, '_blank');
                        } else if (data.data && data.data.payUrl) {
                            log('获取到payUrl, 跳转中...');
                            window.open(data.data.payUrl, '_blank');
                        } else if (data.data && data.data.qrCode) {
                            log('获取到二维码数据');
                            showQRCodeFallback(data.data.qrCode, bizId);
                        }
                    } catch (e) {
                        log('check调用失败: ' + e.message);
                    }
                }

                if (!document.querySelector('[class*="pay"], [class*="qrcode"]')) {
                    log('所有自动恢复策略已尝试, 请手动操作');
                    alert(`已抢到 bizId=${state.bizId}\n\n请手动操作支付`);
                }
            } else {
                log('支付弹窗已出现!');
            }
        } finally {
            recovering = false;
        }
    }

    function showQRCodeFallback(qrData, bizId) {
        const div = document.createElement('div');
        div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;background:#fff;padding:30px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);text-align:center';
        div.innerHTML = `
            <h3 style="margin:0 0 15px;color:#333">扫码支付</h3>
            <img src="${qrData}" style="width:200px;height:200px" onerror="this.parentElement.innerHTML+='<p>二维码加载失败</p>'">
            <p style="margin:15px 0 0;color:#666;font-size:13px">bizId: ${bizId}</p>
            <button onclick="this.parentElement.remove()" style="margin-top:10px;padding:6px 20px;border:1px solid #ddd;border-radius:4px;cursor:pointer">关闭</button>
        `;
        document.body.appendChild(div);
        log('已显示兜底支付二维码');
    }

    function setupDialogWatcher() {
        const observer = new MutationObserver(() => {
            if (state.lastSuccess && recoveryAttempts < CFG.recoveryMax) {
                const d = findErrorDialog();
                if (d) autoRecover();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ═══════════════════════════════════════════
    //  手动抢购
    // ═══════════════════════════════════════════
    function findBuyButton() {
        for (const el of document.querySelectorAll('button.buy-btn')) {
            if (el.offsetParent !== null) return el;
        }
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            const t = el.textContent.trim();
            if (/购买|抢购|下单|特惠/.test(t) && t.length < 15 && el.offsetParent !== null) return el;
        }
        return null;
    }

    async function startProactive() {
        if (state.status === 'success') {
            log('已经抢到了, 不重复抢购');
            return;
        }

        if (!state.captured) {
            log('构造请求...');
            const req = await autoGrab();
            if (!state.captured) {
                log('构造请求失败', 'warn');
                return;
            }
            log('请求已构造, 开始抢购!');
        }

        setState({ proactive: true });
        log(`手动抢购启动! 前${CFG.turboSec}秒${CFG.turboConcurrency}路并发, 之后${CFG.concurrency}路`);

        const { url, method, body, headers } = state.captured;
        const result = await retry(url, { method, body, headers });
        setState({ proactive: false });

        if (result.ok) {
            setState({ cache: { text: result.text, data: result.data } });
            log('抢购成功! 触发支付...');
            try { new Notification('GLM 抢购成功!', { body: `bizId=${state.bizId}` }); } catch {}
            const errDlg = findErrorDialog();
            if (errDlg) { dismissDialog(errDlg); await sleep(300); }
            const btn = findBuyButton();
            if (btn) { btn.click(); log('已自动点击购买按钮'); }
            else { alert('已获取到商品! 请立即点击购买按钮!'); }

            await sleep(1500);
            forcePayDialog(result.data);
        }
    }

    function stopAll() {
        stopRequested = true;
        setState({ proactive: false, status: 'idle', count: 0 });
        log('已停止');
    }

    // ═══════════════════════════════════════════
    //  快捷键
    // ═══════════════════════════════════════════
    document.addEventListener('keydown', e => {
        if (!e.altKey) return;
        if (e.key === 's' || e.key === 'S') { e.preventDefault(); startProactive(); }
        if (e.key === 'x' || e.key === 'X') { e.preventDefault(); stopAll(); }
        if (e.key === 'h' || e.key === 'H') {
            e.preventDefault();
            if (_shadowRef) {
                const bd = _shadowRef.getElementById('bd');
                if (bd) bd.style.display = bd.style.display === 'none' ? '' : 'none';
            }
        }
    });

    // ═══════════════════════════════════════════
    //  Vue 反售罄补丁 (不碰 disabled/canBuy)
    // ═══════════════════════════════════════════
    function patchVueServerBusy() {
        let attempts = 0;
        const tid = setInterval(() => {
            attempts++;
            if (attempts > 60) { clearInterval(tid); return; }
            let patched = 0;

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

            const buyBtns = document.querySelectorAll('.buy-btn, button.buy-btn[disabled]');
            for (const btn of buyBtns) {
                if (btn.disabled) { btn.disabled = false; btn.classList.remove('is-disabled', 'disabled'); patched++; }
                const text = (btn.textContent || '').trim();
                if (/售罄|补货|已抢完/.test(text)) {
                    btn.textContent = '特惠订阅';
                    patched++;
                }
            }

            const soldOutTags = document.querySelectorAll('[class*="sold-out"], [class*="soldOut"]');
            for (const el of soldOutTags) {
                if (el.textContent && /售罄|已售/.test(el.textContent)) {
                    el.style.display = 'none';
                    patched++;
                }
            }

            if (patched > 0 && attempts % 10 === 0) {
                log(`反售罄patch: ${patched}处 (第${attempts}次)`);
            }
        }, 1000);
    }

    function forcePayDialog(responseData) {
        const app = document.querySelector('#app');
        const vue = app && app.__vue__;
        if (!vue) return;

        let payComp = null;
        const findComp = (vm, depth) => {
            if (depth > 8) return;
            if (vm.$data && 'payDialogVisible' in vm.$data) { payComp = vm; return; }
            for (const child of (vm.$children || [])) { findComp(child, depth + 1); if (payComp) return; }
        };
        findComp(vue, 0);
        if (!payComp) { log('未找到支付组件'); return; }

        if (payComp.payDialogVisible) { log('支付弹窗已显示'); return; }

        const data = responseData && responseData.data;
        if (data) {
            if (typeof payComp.$set === 'function') {
                payComp.$set(payComp, 'priceData', data);
                payComp.$set(payComp, 'payDialogVisible', true);
            } else {
                payComp.priceData = data;
                payComp.payDialogVisible = true;
            }
            log('已直接设置 payDialogVisible=true');
        } else {
            log('响应数据无 data 字段, 无法设置');
        }
    }

    // ═══════════════════════════════════════════
    //  浮动面板 (Shadow DOM)
    // ═══════════════════════════════════════════
    function createPanel() {
        const host = document.createElement('div');
        host.id = 'glm-rush-host';
        const shadow = host.attachShadow({ mode: 'closed' });

        shadow.innerHTML = `
<style>
:host{all:initial;position:fixed;top:10px;right:10px;z-index:999999;font-family:Consolas,'Courier New',monospace}
*{box-sizing:border-box;margin:0;padding:0}
.panel{width:320px;background:#1a1a2e;color:#e0e0e0;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);font-size:13px;line-height:1.5;user-select:none}
.hd{background:linear-gradient(135deg,#0f3460,#16213e);padding:9px 14px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:move}
.hd b{font-size:14px;letter-spacing:.5px}
.mn{background:none;border:none;color:#aaa;cursor:pointer;font-size:20px;line-height:1;padding:0 4px}
.mn:hover{color:#fff}
.bd{padding:12px 14px 14px}
.st{padding:8px;border-radius:8px;text-align:center;font-weight:700;margin-bottom:10px;transition:background .3s}
.st-idle{background:#2d3436}
.st-retrying{background:#e17055;animation:pulse 1s infinite}
.st-success{background:#00b894}
.st-failed{background:#d63031}
@keyframes pulse{50%{opacity:.7}}
.cap{font-size:11px;padding:5px 8px;background:#2d3436;border-radius:6px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pkgs{margin-bottom:10px}
.pkgs-label{font-size:10px;color:#888;margin-bottom:4px}
.pkgs-row{display:flex;gap:4px;margin-bottom:4px}
.pkgs-row:last-child{margin-bottom:0}
.pkgs button{border:none;border-radius:5px;cursor:pointer;font-size:11px;padding:3px 8px;font-weight:600;transition:all .15s}
.pkgs button.type-btn{background:#2d3436;color:#aaa}
.pkgs button.type-btn.active{background:#6c5ce7;color:#fff}
.pkgs button.tier-btn{background:#2d3436;color:#aaa;flex:1}
.pkgs button.tier-btn.active{background:#0984e3;color:#fff}
.pkgs button:hover{opacity:.8}
.row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;flex-wrap:wrap}
.row input[type=number]{width:60px;padding:4px 6px;border:1px solid #444;border-radius:4px;background:#2d3436;color:#fff;text-align:center;font-size:12px}
.btns{display:flex;gap:8px;margin-bottom:10px}
.btns button{flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;color:#fff;transition:opacity .2s}
.btns button:hover{opacity:.85}
.b-go{background:#0984e3}
.b-stop{background:#d63031}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;font-size:11px;text-align:center}
.stats div{background:#2d3436;border-radius:4px;padding:4px}
.stats .v{font-size:16px;font-weight:700;color:#74b9ff}
.logs{max-height:180px;overflow-y:auto;background:#0d1117;border-radius:6px;padding:6px 8px;font-size:11px;line-height:1.7}
.logs div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.logs .ok{color:#00b894} .logs .warn{color:#fdcb6e} .logs .err{color:#d63031} .logs .info{color:#dfe6e9}
.logs::-webkit-scrollbar{width:4px}
.logs::-webkit-scrollbar-thumb{background:#444;border-radius:2px}
.keys{font-size:10px;color:#636e72;text-align:center;margin-top:6px}
</style>
<div class="panel">
  <div class="hd" id="drag"><b>GLM v5.5</b><button class="mn" id="min">-</button></div>
  <div class="bd" id="bd">
    <div class="st st-idle" id="st">等待手动抢购</div>
    <div class="cap" id="cap">${state.captured ? '已恢复上次构造的请求' : '点击"手动抢购"开始'}</div>

    <div class="pkgs" id="pkgs">
      <div class="pkgs-label">套餐类型</div>
      <div class="pkgs-row">
        <button class="type-btn ${CFG.packageType === 'monthly' ? 'active' : ''}" data-type="monthly">包月</button>
        <button class="type-btn ${CFG.packageType === 'quarterly' ? 'active' : ''}" data-type="quarterly">包季</button>
        <button class="type-btn ${CFG.packageType === 'yearly' ? 'active' : ''}" data-type="yearly">包年</button>
      </div>
      <div class="pkgs-label" style="margin-top:6px">套餐规格</div>
      <div class="pkgs-row">
        <button class="tier-btn ${CFG.packageTier === 'lite' ? 'active' : ''}" data-tier="lite">Lite</button>
        <button class="tier-btn ${CFG.packageTier === 'pro' ? 'active' : ''}" data-tier="pro">Pro</button>
        <button class="tier-btn ${CFG.packageTier === 'max' ? 'active' : ''}" data-tier="max">Max</button>
      </div>
    </div>

    <div class="stats">
      <div><div class="v" id="s-cnt">0</div>重试</div>
      <div><div class="v" id="s-ok">0</div>成功</div>
      <div><div class="v" id="s-err">0</div>错误</div>
    </div>
    <div class="row">
      <span>并发</span><input type="number" id="i-conc" value="${CFG.concurrency}" min="1" max="20" step="1">
      <span>极速</span><input type="number" id="i-turbo" value="${CFG.turboConcurrency}" min="1" max="20" step="1">
      <span>上限</span><input type="number" id="i-max" value="${CFG.maxRetry}" min="10" max="9999" step="50">
    </div>
    <div class="btns">
      <button class="b-go" id="b-go">▶ 手动抢购</button>
      <button class="b-stop" id="b-stop" style="display:none">■ 停止</button>
    </div>
    <div class="logs" id="logs"></div>
    <div class="keys">Alt+S 抢购 | Alt+X 停止 | Alt+H 隐藏</div>
  </div>
</div>`;

        document.body.appendChild(host);

        const $ = id => shadow.getElementById(id);
        $('b-go').onclick = startProactive;
        $('b-stop').onclick = stopAll;
        $('i-conc').onchange = function() { CFG.concurrency = Math.max(1, +this.value || 5); saveCfg(CFG); };
        $('i-turbo').onchange = function() { CFG.turboConcurrency = Math.max(1, +this.value || 10); saveCfg(CFG); };
        $('i-max').onchange = function() { CFG.maxRetry = Math.max(10, +this.value || 2000); saveCfg(CFG); };

        shadow.querySelectorAll('.type-btn').forEach(btn => {
            btn.onclick = () => {
                CFG.packageType = btn.dataset.type;
                saveCfg(CFG);
                shadow.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                log(`已选套餐: ${TAB_MAP[CFG.packageType]} + ${TIER_MAP[CFG.packageTier]}`);
            };
        });
        shadow.querySelectorAll('.tier-btn').forEach(btn => {
            btn.onclick = () => {
                CFG.packageTier = btn.dataset.tier;
                saveCfg(CFG);
                shadow.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                log(`已选套餐: ${TAB_MAP[CFG.packageType]} + ${TIER_MAP[CFG.packageTier]}`);
            };
        });

        $('min').onclick = function() {
            const bd = $('bd');
            const hidden = bd.style.display === 'none';
            bd.style.display = hidden ? '' : 'none';
            this.textContent = hidden ? '-' : '+';
        };

        let sx, sy, sl, st;
        $('drag').onmousedown = function(e) {
            sx = e.clientX; sy = e.clientY;
            const rect = host.getBoundingClientRect();
            sl = rect.left; st = rect.top;
            const onMove = e => { host.style.left = (sl + e.clientX - sx) + 'px'; host.style.top = (st + e.clientY - sy) + 'px'; host.style.right = 'auto'; host.style.position = 'fixed'; };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        _shadowRef = shadow;

        log('v5.5 已加载 (手动抢购模式)');
        if (state.captured) log('已恢复上次构造的请求');
        log(`当前套餐: ${TAB_MAP[CFG.packageType]} + ${TIER_MAP[CFG.packageTier]}`);
        setupDialogWatcher();
        patchVueServerBusy();

        if (Notification && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    // ═══════════════════════════════════════════
    //  UI 更新
    // ═══════════════════════════════════════════
    let _uiRafId = null;
    let _uiDirty = false;

    function refreshUI() {
        _uiDirty = true;
        if (_uiRafId !== null) return;
        _uiRafId = requestAnimationFrame(() => {
            _uiRafId = null;
            if (!_uiDirty) return;
            _uiDirty = false;
            const shadow = _shadowRef;
            if (!shadow) return;
            const $ = id => shadow.getElementById(id);

            const stEl = $('st');
            if (stEl) {
                stEl.className = 'st st-' + state.status;
                const isTurbo = state.stats.startTime && (performance.now() - state.stats.startTime) < CFG.turboSec * 1000;
                stEl.textContent = state.status === 'idle' ? '等待手动抢购'
                    : state.status === 'retrying' ? `${isTurbo ? '⚡极速' : ''}重试中... ${state.count}/${CFG.maxRetry}`
                    : state.status === 'success' ? `成功! bizId=${state.bizId}`
                    : `失败 (${state.count}次)`;
            }

            const capEl = $('cap');
            if (capEl) {
                capEl.textContent = state.captured
                    ? `已构造: ${state.captured.method} ...${state.captured.url.split('?')[0].slice(-30)}`
                    : '点击"手动抢购"直接开始';
            }

            const cntEl = $('s-cnt'); if (cntEl) cntEl.textContent = state.count;
            const okEl = $('s-ok'); if (okEl) okEl.textContent = state.stats.success;
            const errEl = $('s-err'); if (errEl) errEl.textContent = state.stats.errors;

            const goBtn = $('b-go');
            const stopBtn = $('b-stop');
            if (goBtn && stopBtn) {
                goBtn.style.display = state.status === 'retrying' ? 'none' : '';
                stopBtn.style.display = state.status === 'retrying' ? '' : 'none';
            }
        });
    }

    function appendLogDOM(entry) {
        const shadow = _shadowRef;
        if (!shadow) return;
        const el = shadow.getElementById('logs');
        if (!el) return;
        const div = document.createElement('div');
        div.className = entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : entry.msg.includes('成功') ? 'ok' : 'info';
        div.textContent = `${entry.ts} ${entry.msg}`;
        el.appendChild(div);
        while (el.children.length > CFG.logMax) el.removeChild(el.firstChild);
        el.scrollTop = el.scrollHeight;
    }

    // ═══════════════════════════════════════════
    //  离开保护
    // ═══════════════════════════════════════════
    window.addEventListener('beforeunload', e => {
        if (state.status === 'retrying') {
            e.preventDefault();
            e.returnValue = '抢购正在进行中，确定要离开吗？';
        }
    });

    // ═══════════════════════════════════════════
    //  启动
    // ═══════════════════════════════════════════
    console.log('[GLM] v5.5 已注入 (手动模式)');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createPanel);
    } else {
        createPanel();
    }
})();
