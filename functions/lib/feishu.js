// 飞书开放平台服务端封装（EdgeOne Pages Functions 版）
// 环境变量通过函数 context.env 传入，App Secret 永不出现在浏览器

const BASE_URL = 'https://open.feishu.cn/open-apis';

export class FeishuError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// env 为 EdgeOne 传入的 context.env；每次冷启动创建一个客户端实例
export function createFeishu(env) {
  // token 缓存在单次函数实例生命周期内复用，过期前 2 分钟提前刷新
  let cachedToken = '';
  let tokenExpireAt = 0;

  function requireEnv() {
    const appId = env.FEISHU_APP_ID;
    const appSecret = env.FEISHU_APP_SECRET;
    const baseToken = env.FEISHU_BASE_TOKEN;
    const tableId = env.FEISHU_TABLE_ID;
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

  // 按条件查询记录，conditions 例：
  // [{ field_name: '学号', operator: 'is', value: ['2023000000'] }]
  async function searchRecords(conditions, pageSize = 1) {
    const { baseToken, tableId } = requireEnv();
    const data = await bitableRequest(
      `/bitable/v1/apps/${baseToken}/tables/${tableId}/records/search?page_size=${pageSize}`,
      {
        method: 'POST',
        body: JSON.stringify({ filter: { conjunction: 'and', conditions } }),
      }
    );
    return { items: data.items || [], total: data.total || 0 };
  }

  // 新增一条记录
  async function createRecord(fields) {
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

  return { searchRecords, createRecord };
}
