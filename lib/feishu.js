// 飞书开放平台服务端封装：tenant_access_token 缓存 + 多维表格记录读写
// App ID / App Secret 只存在于 Vercel 环境变量中，前端永远接触不到

const BASE_URL = 'https://open.feishu.cn/open-apis';

// 模块级缓存：函数实例复用时直接用缓存 token，过期前 2 分钟提前刷新
let cachedToken = '';
let tokenExpireAt = 0;

export class FeishuError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function requireEnv() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const baseToken = process.env.FEISHU_BASE_TOKEN;
  const tableId = process.env.FEISHU_TABLE_ID;
  if (!appId || !appSecret || !baseToken || !tableId) {
    throw new FeishuError('服务端缺少飞书环境变量配置', 500);
  }
  return { appId, appSecret, baseToken, tableId };
}

async function getTenantToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpireAt - 120_000) return cachedToken;

  const { appId, appSecret } = requireEnv();
  const resp = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await resp.json();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new FeishuError(`获取 tenant_access_token 失败：${data.msg || '未知错误'}`);
  }
  cachedToken = data.tenant_access_token;
  tokenExpireAt = now + data.expire * 1000;
  return cachedToken;
}

async function bitableRequest(path, options = {}) {
  const token = await getTenantToken();
  const resp = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const data = await resp.json();
  if (data.code !== 0) {
    // 常见错误：91402/91403 无权限（应用未加为表格协作者），1254xxx 参数问题
    throw new FeishuError(`飞书接口错误（${data.code}）：${data.msg || '未知错误'}`);
  }
  return data.data;
}

// 按条件查询记录，返回 { items, total }
// conditions 例：[{ field_name: '学号', operator: 'is', value: ['2023000000'] }]
export async function searchRecords(conditions, pageSize = 1) {
  const { baseToken, tableId } = requireEnv();
  const data = await bitableRequest(
    `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/search?page_size=${pageSize}`,
    {
      method: 'POST',
      body: JSON.stringify({
        filter: { conjunction: 'and', conditions },
      }),
    }
  );
  return { items: data.items || [], total: data.total || 0 };
}

// 新增一条记录，fields 例：{ '学号': '...', '面试时间': '周六上午 9:00 - 11:00' }
export async function createRecord(fields) {
  const { baseToken, tableId } = requireEnv();
  const data = await bitableRequest(
    `/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
    {
      method: 'POST',
      body: JSON.stringify({ fields }),
    }
  );
  return data.record;
}
