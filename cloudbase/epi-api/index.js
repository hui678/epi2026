/**
 * EPI 一面预约 —— CloudBase HTTP 云函数（零依赖、原生 http 服务）
 *
 * 通过 scf_bootstrap 启动本文件，监听平台指定端口（PORT 环境变量）。
 * 路由：
 *   GET  /api/counts  各时段已约人数
 *   POST /api/book    提交预约
 *   OPTIONS *         CORS 预检
 */

const http = require('http');

// ====== 时间段配置（label 必须与飞书表「面试时间」单选选项完全一致） ======
const SLOTS = {
    'sat-am': { label: '周六上午 9:00 - 11:00', capacity: 10 },
    'sat-pm': { label: '周六下午 14:00 - 16:00', capacity: 10 },
    'sun-am': { label: '周日上午 9:00 - 11:00', capacity: 10 },
    'sun-pm': { label: '周日下午 14:00 - 16:00', capacity: 10 },
};

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// 实例级 token 缓存
let cachedToken = '';
let tokenExpireAt = 0;

// ---------- 工具 ----------

function send(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
    res.end(JSON.stringify(payload));
}

function clean(value, maxLen) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function requireConfig() {
    const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_BASE_TOKEN, FEISHU_TABLE_ID } = process.env;
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_BASE_TOKEN || !FEISHU_TABLE_ID) {
        throw new Error('缺少飞书环境变量配置');
    }
    return { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_BASE_TOKEN, FEISHU_TABLE_ID };
}

async function getTenantToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpireAt - 120000) return cachedToken;
    const { FEISHU_APP_ID, FEISHU_APP_SECRET } = requireConfig();
    const resp = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
    });
    const data = await resp.json();
    if (data.code !== 0 || !data.tenant_access_token) {
        throw new Error(`获取飞书 token 失败：${data.msg || '未知错误'}`);
    }
    cachedToken = data.tenant_access_token;
    tokenExpireAt = now + data.expire * 1000;
    return cachedToken;
}

async function feishuRequest(path, options = {}) {
    const token = await getTenantToken();
    const resp = await fetch(`${FEISHU_BASE}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${token}`,
            ...(options.headers || {}),
        },
    });
    const data = await resp.json();
    if (data.code !== 0) {
        const err = new Error(`飞书接口错误（${data.code}）：${data.msg || '未知错误'}`);
        err.feishuCode = data.code;
        throw err;
    }
    return data.data;
}

async function searchRecords(conditions, pageSize = 1) {
    const { FEISHU_BASE_TOKEN, FEISHU_TABLE_ID } = requireConfig();
    const data = await feishuRequest(
        `/bitable/v1/apps/${FEISHU_BASE_TOKEN}/tables/${FEISHU_TABLE_ID}/records/search?page_size=${pageSize}`,
        { method: 'POST', body: JSON.stringify({ filter: { conjunction: 'and', conditions } }) }
    );
    return { items: data.items || [], total: data.total || 0 };
}

async function createRecord(fields) {
    const { FEISHU_BASE_TOKEN, FEISHU_TABLE_ID } = requireConfig();
    return feishuRequest(
        `/bitable/v1/apps/${FEISHU_BASE_TOKEN}/tables/${FEISHU_TABLE_ID}/records`,
        { method: 'POST', body: JSON.stringify({ fields }) }
    );
}

// ---------- 业务处理 ----------

async function handleCounts(res) {
    const entries = await Promise.all(
        Object.entries(SLOTS).map(async ([id, slot]) => {
            const { total } = await searchRecords([
                { field_name: '面试时间', operator: 'is', value: [slot.label] },
            ]);
            return [id, total];
        })
    );
    send(res, 200, { ok: true, counts: Object.fromEntries(entries) });
}

async function handleBook(res, rawBody) {
    let body;
    try {
        body = JSON.parse(rawBody || '{}');
    } catch {
        return send(res, 400, { ok: false, message: '请求格式错误' });
    }

    const studentId = clean(body.studentId, 10);
    const name = clean(body.name, 20);
    const className = clean(body.className, 30);
    const slotId = clean(body.slot, 20);

    if (!/^\d{10}$/.test(studentId)) {
        return send(res, 400, { ok: false, field: 'studentId', message: '学号必须为 10 位数字' });
    }
    if (!name) return send(res, 400, { ok: false, field: 'name', message: '请输入姓名' });
    if (!className) return send(res, 400, { ok: false, field: 'className', message: '请输入班级' });
    const slot = SLOTS[slotId];
    if (!slot) return send(res, 400, { ok: false, field: 'slot', message: '面试时间不合法' });

    const dup = await searchRecords([{ field_name: '学号', operator: 'is', value: [studentId] }]);
    if (dup.total > 0) {
        return send(res, 409, {
            ok: false, code: 'DUPLICATE_STUDENT',
            message: '该学号已预约过，无需重复提交。如需修改请联系管理员。',
        });
    }

    const booked = await searchRecords([{ field_name: '面试时间', operator: 'is', value: [slot.label] }]);
    if (booked.total >= slot.capacity) {
        return send(res, 409, { ok: false, code: 'SLOT_FULL', message: '该时间段已约满，请选择其他时间。' });
    }

    await createRecord({ 学号: studentId, 姓名: name, 班级: className, 面试时间: slot.label });
    send(res, 200, { ok: true, slot: { id: slotId, label: slot.label } });
}

// ---------- HTTP 服务入口 ----------

async function handleRequest(req, res) {
    // CORS 预检
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    try {
        if (path.endsWith('/api/counts') && req.method === 'GET') {
            return await handleCounts(res);
        }
        if (path.endsWith('/api/book') && req.method === 'POST') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            return await handleBook(res, Buffer.concat(chunks).toString('utf8'));
        }
        send(res, 404, { ok: false, message: 'Not Found' });
    } catch (err) {
        console.error('云函数异常：', err);
        send(res, 502, { ok: false, message: err.message || '服务异常，请稍后重试' });
    }
}

const PORT = process.env.PORT || 9000;
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
    console.log(`epi-api listening on port ${PORT}`);
});

// 保持进程不退出（云托管框架会管理生命周期）
process.on('SIGTERM', () => server.close(() => process.exit(0)));
