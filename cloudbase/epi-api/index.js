/**
 * EPI 一面预约 —— CloudBase HTTP 云函数（单文件、零第三方依赖）
 *
 * 部署形态：腾讯云开发「HTTP 云函数」+ HTTP 网关，触发路径前缀 /api
 *   GET  /api/counts  各时段已约人数
 *   POST /api/book    提交预约
 *   OPTIONS /api/*    CORS 预检
 *
 * 环境变量（云函数配置页填写）：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN / FEISHU_TABLE_ID
 */

// ====== 时间段配置（label 必须与飞书表「面试时间」单选选项完全一致） ======
const SLOTS = {
    'sat-am': { label: '周六上午 9:00 - 11:00', capacity: 10 },
    'sat-pm': { label: '周六下午 14:00 - 16:00', capacity: 10 },
    'sun-am': { label: '周日上午 9:00 - 11:00', capacity: 10 },
    'sun-pm': { label: '周日下午 14:00 - 16:00', capacity: 10 },
};

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// 实例级 token 缓存（云函数实例复用时生效）
let cachedToken = '';
let tokenExpireAt = 0;

// ---------- 工具 ----------

function corsResponse(status, payload) {
    return {
        statusCode: status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
        body: JSON.stringify(payload),
    };
}

function clean(value, maxLen) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    return text.length > maxLen ? text.slice(0, maxLen) : text;
}

async function getTenantToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpireAt - 120000) return cachedToken;

    const resp = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            app_id: process.env.FEISHU_APP_ID,
            app_secret: process.env.FEISHU_APP_SECRET,
        }),
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

function requireConfig() {
    const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_BASE_TOKEN, FEISHU_TABLE_ID } = process.env;
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_BASE_TOKEN || !FEISHU_TABLE_ID) {
        throw new Error('缺少飞书环境变量配置');
    }
    return { FEISHU_BASE_TOKEN, FEISHU_TABLE_ID };
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

async function handleCounts() {
    const entries = await Promise.all(
        Object.entries(SLOTS).map(async ([id, slot]) => {
            const { total } = await searchRecords([
                { field_name: '面试时间', operator: 'is', value: [slot.label] },
            ]);
            return [id, total];
        })
    );
    return corsResponse(200, { ok: true, counts: Object.fromEntries(entries) });
}

async function handleBook(rawBody) {
    let body;
    try {
        body = JSON.parse(rawBody || '{}');
    } catch {
        return corsResponse(400, { ok: false, message: '请求格式错误' });
    }

    const studentId = clean(body.studentId, 10);
    const name = clean(body.name, 20);
    const className = clean(body.className, 30);
    const slotId = clean(body.slot, 20);

    if (!/^\d{10}$/.test(studentId)) {
        return corsResponse(400, { ok: false, field: 'studentId', message: '学号必须为 10 位数字' });
    }
    if (!name) {
        return corsResponse(400, { ok: false, field: 'name', message: '请输入姓名' });
    }
    if (!className) {
        return corsResponse(400, { ok: false, field: 'className', message: '请输入班级' });
    }
    const slot = SLOTS[slotId];
    if (!slot) {
        return corsResponse(400, { ok: false, field: 'slot', message: '面试时间不合法' });
    }

    // 学号查重
    const dup = await searchRecords([
        { field_name: '学号', operator: 'is', value: [studentId] },
    ]);
    if (dup.total > 0) {
        return corsResponse(409, {
            ok: false,
            code: 'DUPLICATE_STUDENT',
            message: '该学号已预约过，无需重复提交。如需修改请联系管理员。',
        });
    }

    // 名额校验
    const booked = await searchRecords([
        { field_name: '面试时间', operator: 'is', value: [slot.label] },
    ]);
    if (booked.total >= slot.capacity) {
        return corsResponse(409, {
            ok: false,
            code: 'SLOT_FULL',
            message: '该时间段已约满，请选择其他时间。',
        });
    }

    await createRecord({
        学号: studentId,
        姓名: name,
        班级: className,
        面试时间: slot.label,
    });

    return corsResponse(200, { ok: true, slot: { id: slotId, label: slot.label } });
}

// ---------- CloudBase HTTP 云函数入口 ----------

exports.main = async (event = {}) => {
    const method = (event.httpMethod || 'GET').toUpperCase();
    const path = event.path || event.requestContext?.path || '';

    // CORS 预检
    if (method === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            },
            body: '',
        };
    }

    try {
        if (path.endsWith('/api/counts') && method === 'GET') {
            return await handleCounts();
        }
        if (path.endsWith('/api/book') && method === 'POST') {
            // HTTP 网关可能对 body 做 base64 编码
            let rawBody = event.body;
            if (event.isBase64Encoded && rawBody) {
                rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
            }
            return await handleBook(rawBody);
        }
        return corsResponse(404, { ok: false, message: 'Not Found' });
    } catch (err) {
        console.error('云函数异常：', err);
        return corsResponse(502, { ok: false, message: err.message || '服务异常，请稍后重试' });
    }
};
