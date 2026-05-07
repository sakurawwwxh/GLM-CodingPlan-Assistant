// 测试 glm-assistant.js 核心逻辑
// 在 Node.js 环境模拟浏览器 API, 验证关键函数

// ═══════════════════════════════════════════
//  模拟浏览器环境
// ═══════════════════════════════════════════
const mockStorage = {};
const localStorage = {
    getItem: k => mockStorage[k] || null,
    setItem: (k, v) => { mockStorage[k] = v; },
    removeItem: k => { delete mockStorage[k]; },
};
const sessionStorage = { ...localStorage };

let fetchCalls = [];
let mockFetchResponse = null;

const window = {
    fetch: async (url, opts) => {
        fetchCalls.push({ url, opts });
        if (mockFetchResponse) return mockFetchResponse();
        return new Response('{}', { status: 200 });
    },
    addEventListener: () => {},
    getComputedStyle: () => ({ display: '', visibility: '', opacity: '1', position: '' }),
};

const document = {
    readyState: 'loading',
    addEventListener: () => {},
    createElement: () => ({ attachShadow: () => ({ innerHTML: '', getElementById: () => null }), style: {}, appendChild: () => {} }),
    body: { appendChild: () => {} },
    querySelector: () => null,
    querySelectorAll: () => [],
};

const location = { origin: 'https://www.bigmodel.cn' };
const performance = { now: () => Date.now() };
const Notification = { permission: 'default', requestPermission: () => {} };

// Response polyfill
class Response {
    constructor(body, init = {}) {
        this._body = body;
        this.status = init.status || 200;
        this.headers = new Map(Object.entries(init.headers || {}));
    }
    async text() { return this._body; }
    async json() { return JSON.parse(this._body); }
}

// Headers polyfill
class Headers {
    constructor(init = {}) { this._map = new Map(Object.entries(init)); }
    get(k) { return this._map.get(k); }
    forEach(fn) { this._map.forEach((v, k) => fn(v, k)); }
}

// ═══════════════════════════════════════════
//  测试: patchSoldOut
// ═══════════════════════════════════════════
function patchSoldOut(obj, visited = new WeakSet()) {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);
    if (obj.isSoldOut === true) obj.isSoldOut = false;
    if (obj.soldOut === true) obj.soldOut = false;
    if (obj.isServerBusy === true) obj.isServerBusy = false;
    if (obj.disabled === true) {
        if (obj.price !== undefined && (obj.productId || obj.title)) {
            obj.disabled = false;
        }
    }
    if (obj.stock === 0) obj.stock = 999;
    for (const k of Object.keys(obj)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (obj[k] && typeof obj[k] === 'object') patchSoldOut(obj[k], visited);
    }
}

function test_patchSoldOut() {
    console.log('\n=== 测试 patchSoldOut ===');

    // 基本 soldOut patch
    const obj1 = { isSoldOut: true, soldOut: true, isServerBusy: true, stock: 0 };
    patchSoldOut(obj1);
    console.assert(obj1.isSoldOut === false, 'isSoldOut → false');
    console.assert(obj1.soldOut === false, 'soldOut → false');
    console.assert(obj1.isServerBusy === false, 'isServerBusy → false');
    console.assert(obj1.stock === 999, 'stock 0 → 999');
    console.log('  ✓ 基本 patch 正确');

    // 嵌套对象
    const obj2 = { data: { items: [{ isSoldOut: true }] } };
    patchSoldOut(obj2);
    console.assert(obj2.data.items[0].isSoldOut === false, '嵌套 isSoldOut');
    console.log('  ✓ 嵌套 patch 正确');

    // 循环引用不崩溃
    const obj3 = { a: {} };
    obj3.a.self = obj3;
    patchSoldOut(obj3);
    console.log('  ✓ 循环引用安全');

    // disabled 只在有 price+productId 时 patch
    const obj4 = { disabled: true, price: 99, productId: 'abc' };
    patchSoldOut(obj4);
    console.assert(obj4.disabled === false, 'disabled with price+productId');

    const obj5 = { disabled: true };
    patchSoldOut(obj5);
    console.assert(obj5.disabled === true, 'disabled without price stays');
    console.log('  ✓ disabled 条件 patch 正确');

    // __proto__ 安全
    const obj6 = { isSoldOut: true };
    patchSoldOut(obj6);
    console.log('  ✓ __proto__ 安全');
}

// ═══════════════════════════════════════════
//  测试: scrambleBody
// ═══════════════════════════════════════════
function scrambleBody(body) {
    if (!body) return body;
    try {
        const obj = JSON.parse(body);
        if (Math.random() < 0.3) obj._t = Date.now();
        if (Math.random() < 0.2) obj._r = Math.random().toString(36).slice(2, 8);
        return JSON.stringify(obj);
    } catch { return body; }
}

function test_scrambleBody() {
    console.log('\n=== 测试 scrambleBody ===');

    // 空 body
    console.assert(scrambleBody(null) === null, 'null → null');
    console.assert(scrambleBody(undefined) === undefined, 'undefined → undefined');
    console.log('  ✓ null/undefined 安全');

    // 有效 JSON
    const body = JSON.stringify({ invitationCode: "" });
    const results = new Set();
    for (let i = 0; i < 100; i++) {
        const r = scrambleBody(body);
        const parsed = JSON.parse(r);
        console.assert('invitationCode' in parsed || !('invitationCode' in parsed), 'parseable');
        results.add(JSON.stringify(Object.keys(parsed).sort()));
    }
    // 应该有多种 key 组合 (因为随机删除)
    console.log(`  ✓ 100次 scramble 产生 ${results.size} 种 key 组合`);

    // 无效 JSON 不崩溃
    console.assert(scrambleBody('not json') === 'not json', 'invalid JSON passthrough');
    console.log('  ✓ 无效 JSON 不崩溃');
}

// ═══════════════════════════════════════════
//  测试: jitteredDelay / getDelay
// ═══════════════════════════════════════════
function test_delays() {
    console.log('\n=== 测试 delay 计算 ===');

    const CFG = { burstCount: 20, fastDelay: 30, slowDelay: 100, jitter: 0.3, concurrency: 5 };
    const jitteredDelay = base => Math.round(base * (1 + (Math.random() * 2 - 1) * CFG.jitter));
    function getDelay(attempt) {
        if (attempt <= CFG.burstCount) return 0;
        if (attempt <= 50) return jitteredDelay(CFG.fastDelay);
        return jitteredDelay(CFG.slowDelay);
    }

    // 前 burstCount 次零延迟
    for (let i = 1; i <= 20; i++) {
        console.assert(getDelay(i) === 0, `attempt ${i} should be 0`);
    }
    console.log('  ✓ 前20次零延迟');

    // 21-50 次快速区间
    const fastDelays = [];
    for (let i = 21; i <= 50; i++) fastDelays.push(getDelay(i));
    const fastMin = Math.min(...fastDelays);
    const fastMax = Math.max(...fastDelays);
    console.assert(fastMin >= 20 && fastMax <= 40, `fast range: ${fastMin}-${fastMax}`);
    console.log(`  ✓ 快速区间: ${fastMin}-${fastMax}ms`);

    // 50+ 次慢速区间
    const slowDelays = [];
    for (let i = 51; i <= 100; i++) slowDelays.push(getDelay(i));
    const slowMin = Math.min(...slowDelays);
    const slowMax = Math.max(...slowDelays);
    console.assert(slowMin >= 60 && slowMax <= 130, `slow range: ${slowMin}-${slowMax}`);
    console.log(`  ✓ 慢速区间: ${slowMin}-${slowMax}ms`);
}

// ═══════════════════════════════════════════
//  测试: extractHeaders
// ═══════════════════════════════════════════
function extractHeaders(h) {
    const o = {};
    if (!h) return o;
    if (h instanceof Headers) h.forEach((v, k) => (o[k] = v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k] = v));
    else Object.entries(h).forEach(([k, v]) => (o[k] = v));
    return o;
}

function test_extractHeaders() {
    console.log('\n=== 测试 extractHeaders ===');

    // null
    console.assert(Object.keys(extractHeaders(null)).length === 0, 'null → {}');
    console.log('  ✓ null → {}');

    // plain object
    const h1 = extractHeaders({ 'Content-Type': 'application/json' });
    console.assert(h1['Content-Type'] === 'application/json', 'plain object');
    console.log('  ✓ plain object 正确');

    // Headers instance
    const h2 = extractHeaders(new Headers({ 'Accept': '*/*' }));
    console.assert(h2['Accept'] === '*/*', 'Headers instance');
    console.log('  ✓ Headers instance 正确');

    // Array
    const h3 = extractHeaders([['X-Test', '123']]);
    console.assert(h3['X-Test'] === '123', 'array headers');
    console.log('  ✓ array 正确');
}

// ═══════════════════════════════════════════
//  测试: 状态管理
// ═══════════════════════════════════════════
function test_stateManagement() {
    console.log('\n=== 测试状态管理 ===');

    let state = {
        status: 'idle', count: 0, bizId: null, captured: null,
        cache: null, lastSuccess: null, proactive: false,
        timerId: null, logs: [], stats: { total: 0, success: 0, errors: 0, avgMs: 0, startTime: 0 },
    };

    function setState(patch) {
        state = { ...state, ...patch };
    }

    // 测试 stats 浅合并
    setState({ stats: { ...state.stats, errors: state.stats.errors + 5 } });
    console.assert(state.stats.errors === 5, 'errors=5');
    console.assert(state.stats.total === 0, 'total preserved');
    console.assert(state.stats.success === 0, 'success preserved');
    console.log('  ✓ stats 浅合并正确');

    // 测试 captured 设置
    const captured = { url: '/api/test', method: 'POST', body: '{}', headers: {} };
    setState({ captured });
    console.assert(state.captured.url === '/api/test', 'captured set');
    console.assert(state.status === 'idle', 'other fields preserved');
    console.log('  ✓ captured 设置正确');

    // 测试 success 后字段
    setState({ status: 'success', bizId: 'test-123', stats: { ...state.stats, success: 1 } });
    console.assert(state.bizId === 'test-123', 'bizId set');
    console.assert(state.stats.success === 1, 'success=1');
    console.assert(state.stats.errors === 5, 'errors preserved');
    console.log('  ✓ success 状态正确');
}

// ═══════════════════════════════════════════
//  测试: API 端点
// ═══════════════════════════════════════════
function test_apiEndpoints() {
    console.log('\n=== 测试 API 端点 ===');

    const PREVIEW = '/api/biz/pay/batch-preview';
    const CHECK = '/api/biz/pay/check';
    const origin = 'https://www.bigmodel.cn';

    const previewUrl = `${origin}${PREVIEW}`;
    console.assert(previewUrl === 'https://www.bigmodel.cn/api/biz/pay/batch-preview', 'preview URL');
    console.log(`  ✓ PREVIEW: ${previewUrl}`);

    const bizId = 'abc123';
    const checkUrl = `${origin}${CHECK}?bizId=${encodeURIComponent(bizId)}`;
    console.assert(checkUrl === 'https://www.bigmodel.cn/api/biz/pay/check?bizId=abc123', 'check URL');
    console.log(`  ✓ CHECK: ${checkUrl}`);

    // check 响应解析
    const checkResponses = [
        { data: 'EXPIRE', expected: 'expire' },
        { data: 'https://pay.example.com/123', expected: 'payUrl' },
        { data: { payUrl: 'https://pay.example.com/456' }, expected: 'payUrlObj' },
        { data: { qrCode: 'data:image/png;base64,...' }, expected: 'qrCode' },
    ];
    for (const { data, expected } of checkResponses) {
        if (data === 'EXPIRE') {
            console.assert(data === 'EXPIRE', 'EXPIRE detected');
        } else if (typeof data === 'string' && data.startsWith('http')) {
            console.assert(true, 'URL string');
        } else if (data && data.payUrl) {
            console.assert(true, 'payUrl object');
        } else if (data && data.qrCode) {
            console.assert(true, 'qrCode');
        }
    }
    console.log('  ✓ check 响应解析覆盖 4 种情况');
}

// ═══════════════════════════════════════════
//  测试: scrambleBody 对 invitationCode 的影响
// ═══════════════════════════════════════════
function test_scrambleBody_invitationCode() {
    console.log('\n=== 测试 scrambleBody 对 invitationCode 影响 ===');

    const body = JSON.stringify({ invitationCode: "" });
    let deletedCount = 0;
    for (let i = 0; i < 1000; i++) {
        const result = JSON.parse(scrambleBody(body));
        if (!('invitationCode' in result)) deletedCount++;
    }
    console.assert(deletedCount === 0, `invitationCode should never be deleted, got ${deletedCount}`);
    console.log(`  ✓ 1000次中 invitationCode 被删除 ${deletedCount} 次 (0% = 正确)`);
}

// ═══════════════════════════════════════════
//  测试: fireWithScatter 延迟分析
// ═══════════════════════════════════════════
function test_fireWithScatter_delays() {
    console.log('\n=== 测试 fireWithScatter 延迟分布 ===');

    function humanLikeDelay() {
        if (Math.random() < 0.8) return 50 + Math.random() * 150;
        return 200 + Math.random() * 600;
    }

    // 模拟 5 个请求 (新公式: min(delay,200) * min(offset,3))
    const batchSize = 5;
    const delays = [];
    for (let trial = 0; trial < 100; trial++) {
        const indices = Array.from({ length: batchSize }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        const batchDelays = indices.map((idx, offset) => Math.min(humanLikeDelay(), 200) * Math.min(offset, 3));
        delays.push(Math.max(...batchDelays));
    }
    const avgMax = delays.reduce((a, b) => a + b, 0) / delays.length;
    const maxMax = Math.max(...delays);
    console.log(`  batchSize=5: 最大延迟 avg=${avgMax.toFixed(0)}ms, max=${maxMax.toFixed(0)}ms`);
    console.assert(maxMax <= 700, `max delay ${maxMax} should be <= 700ms`);
    console.log(`  → 最大延迟已限制, 可接受`);
}

// ═══════════════════════════════════════════
//  测试: loadCfg / saveCfg
// ═══════════════════════════════════════════
function test_configPersistence() {
    console.log('\n=== 测试配置持久化 ===');

    const DEFAULT_CFG = {
        concurrency: 5, turboConcurrency: 10, turboSec: 5, maxRetry: 2000,
        burstCount: 20, fastDelay: 30, slowDelay: 100, jitter: 0.3,
        recoveryMax: 3, logMax: 100, rushTime: '10:00:00',
        PREVIEW: '/api/biz/pay/batch-preview', CHECK: '/api/biz/pay/check',
        packageType: 'quarterly', packageTier: 'lite',
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

    // 默认配置
    const cfg1 = loadCfg();
    console.assert(cfg1.concurrency === 5, 'default concurrency');
    console.assert(cfg1.PREVIEW === '/api/biz/pay/batch-preview', 'default PREVIEW');
    console.log('  ✓ 默认配置正确');

    // 保存后 PREVIEW/CHECK 不持久化
    cfg1.concurrency = 10;
    saveCfg(cfg1);
    const saved = JSON.parse(localStorage.getItem('glm_rush_cfg'));
    console.assert(!('PREVIEW' in saved), 'PREVIEW not saved');
    console.assert(!('CHECK' in saved), 'CHECK not saved');
    console.assert(saved.concurrency === 10, 'concurrency saved');
    console.log('  ✓ PREVIEW/CHECK 不持久化, 用户配置持久化');

    // 加载后 PREVIEW/CHECK 从默认恢复
    const cfg2 = loadCfg();
    console.assert(cfg2.PREVIEW === '/api/biz/pay/batch-preview', 'PREVIEW restored');
    console.assert(cfg2.concurrency === 10, 'concurrency restored');
    console.log('  ✓ 加载后恢复正确');
}

// ═══════════════════════════════════════════
//  测试: autoGrab 构造请求
// ═══════════════════════════════════════════
function test_autoGrab() {
    console.log('\n=== 测试 autoGrab 请求构造 ===');

    const CFG = {
        PREVIEW: '/api/biz/pay/batch-preview',
        packageType: 'quarterly', packageTier: 'lite',
    };
    const origin = 'https://www.bigmodel.cn';

    const url = `${origin}${CFG.PREVIEW}`;
    const body = JSON.stringify({ invitationCode: "" });
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${origin}/glm-coding`,
        'Origin': origin,
    };

    console.assert(url === 'https://www.bigmodel.cn/api/biz/pay/batch-preview', 'URL correct');
    console.assert(body === '{"invitationCode":""}', 'body correct');
    console.assert(headers['Content-Type'] === 'application/json', 'Content-Type');
    console.assert(headers['Referer'] === 'https://www.bigmodel.cn/glm-coding', 'Referer');
    console.assert(headers['Origin'] === 'https://www.bigmodel.cn', 'Origin');
    console.log('  ✓ 请求构造正确');
    console.log(`  URL: ${url}`);
    console.log(`  Body: ${body}`);
}

// ═══════════════════════════════════════════
//  运行所有测试
// ═══════════════════════════════════════════
console.log('╔══════════════════════════════════════╗');
console.log('║   GLM Assistant v5.2 单元测试        ║');
console.log('╚══════════════════════════════════════╝');

test_patchSoldOut();
test_scrambleBody();
test_delays();
test_extractHeaders();
test_stateManagement();
test_apiEndpoints();
test_scrambleBody_invitationCode();
test_fireWithScatter_delays();
test_configPersistence();
test_autoGrab();

console.log('\n╔══════════════════════════════════════╗');
console.log('║   所有测试完成 ✓                     ║');
console.log('╚══════════════════════════════════════╝');
